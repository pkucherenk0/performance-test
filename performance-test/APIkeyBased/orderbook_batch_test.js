import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import { config, users } from './config.js';

// --- CONFIGURATION (env-driven; see config.js) ---
const BASE_URL = config.baseUrl;
const WS_URL = config.wsUrl;
const MARKET = config.spotMarket;
const CHANNEL = `public.orderbook.increment.${MARKET}`;
const SPAM_DELAY_MS = parseInt(__ENV.SPAM_DELAY_MS || '5', 10);

// --- PRICING CONFIG (ETHUSDT defaults; override via -e) ---
const CENTER_PRICE = parseFloat(__ENV.CENTER_PRICE || '1679');
const PRICE_RANGE = parseInt(__ENV.PRICE_RANGE || '100', 10);
const AMOUNT = __ENV.AMOUNT || '0.01';

// --- METRICS ---
const incrementInterval = new Trend('increment_arrival_delta_ms');
const batchSize = new Trend('increment_batch_size');

function log(msg, type = "INFO") {
    const time = new Date().toISOString().split('T')[1].replace('Z', '');
    const icons = { INFO: "ℹ️", SUCCESS: "✅", WARN: "⚠️", ERROR: "❌", BATCH: "📦", SEND: "📤" };
    console.log(`${icons[type] || ""} [${time}] VU${__VU}: ${msg}`);
}

function getAuthHeaders(apiKey, apiSecret, method, url, bodyObject = {}) {
    if (!apiKey || !apiSecret) throw new Error("Missing API Key/Secret");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    let path = url.replace(/^(?:https?:\/\/|wss?:\/\/)[^\/]+/, "");
    if (!path.startsWith("/")) path = "/" + path;
    const methodUpper = method.toUpperCase();
    let canonicalFieldString = "";
    if (["POST", "PUT", "PATCH", "DELETE"].includes(methodUpper)) {
        try {
            const sortedKeys = Object.keys(bodyObject).sort();
            canonicalFieldString = sortedKeys.map(key => `${key}=${bodyObject[key]}`).join("|");
        } catch (e) {}
    } 
    const prehash = methodUpper + path + timestamp + canonicalFieldString;
    const signature = crypto.hmac('sha256', apiSecret, prehash, 'hex');
    return { 'Content-Type': 'application/json', 'X-API-KEY': apiKey, 'X-TIMESTAMP': timestamp, 'X-SIGNATURE': signature };
}

function safeParseJSON(message) {
    try { return [JSON.parse(message)]; } 
    catch (e) {
        if (message.includes('}{')) {
            return message.replace(/}{/g, '}|{').split('|').map(str => {
                try { return JSON.parse(str); } catch(err) { return null; }
            }).filter(obj => obj !== null);
        }
        return [];
    }
}

export const options = {
  vus: 1, 
  duration: '30s', 
};

export default function () {
  const currentUser = users[0];
  if (!currentUser) { log("No user found in users.json", "ERROR"); return; }
  
  const { sessionId: APP_SESSION_ID, apiKey: API_KEY, apiSecret: API_SECRET } = currentUser;

  let lastIncrementTime = 0;
  let snapshotReceived = false;
  
  // State for strict alternation
  let nextIsBuy = true; 

  const wsHeaders = getAuthHeaders(API_KEY, API_SECRET, 'GET', WS_URL, {});

  const response = ws.connect(WS_URL, { headers: wsHeaders }, function (socket) {
    socket.on('open', function() {
        socket.send(JSON.stringify({ "id": 1, "connect": {} }));
        
        socket.setTimeout(function() {
            log(`Test finished, closing socket.`, "INFO");
            socket.close();
        }, 29000); 
    });

    socket.on('message', function (rawMessage) {
      const messages = safeParseJSON(rawMessage);

      messages.forEach(msg => {
          const now = Date.now();

          // 1. Connected -> Start Spam Loop
          if (msg.id === 1 && msg.connect) {
              log(`Connected. Subscribing and starting Alternating Spam...`, "INFO");
              socket.send(JSON.stringify({ "id": 4, "subscribe": { "channel": CHANNEL } }));

              // --- SPAM LOOP ---
              socket.setInterval(function() {
                  const side = nextIsBuy ? "buy" : "sell";
                  
                  // PRICING LOGIC: Center +/- Step
                  // Buys: 5090 to 5099
                  // Sells: 5101 to 5110
                  const offset = Math.floor(Math.random() * PRICE_RANGE) + 1; // 1 to 10
                  const rawPrice = nextIsBuy ? (CENTER_PRICE - offset) : (CENTER_PRICE + offset);
                  
                  const payload = {
                      "app_session_id": APP_SESSION_ID, "market": MARKET, "side": side,
                      "amount": AMOUNT, "price": rawPrice.toFixed(2), "type": "limit", "time_in_force": "gtc"
                  };
                  
                  // Flip the flag for next time immediately
                  nextIsBuy = !nextIsBuy;

                  try {
                      const url = `${BASE_URL}/spot/order`;
                      const headers = getAuthHeaders(API_KEY, API_SECRET, 'POST', url, payload);
                      
                      // Using async behavior for performance, but checking response
                      const res = http.post(url, JSON.stringify(payload), { headers: headers });

                      // DEBUG: Why are sells failing?
                      if (res.status !== 200) {
                           log(`Failed to send ${side.toUpperCase()} order! Status: ${res.status} | Body: ${res.body}`, "ERROR");
                      }
                  } catch (e) {
                      log(`Exception sending order: ${e}`, "ERROR");
                  }
              }, SPAM_DELAY_MS);
          }

          // 2. Snapshot
          if ((msg.id === 4 && msg.subscribe?.data?.header?.type === 'orderbook.snapshot') || 
              (msg.push?.pub?.data?.header?.type === 'orderbook.snapshot')) {
              if(!snapshotReceived) log(`Snapshot Received.`, "SUCCESS");
              snapshotReceived = true;
          }

          // 3. Increments
          if (snapshotReceived && msg.push && msg.push.channel === CHANNEL) {
              const data = msg.push.pub.data;
              if (data.header && data.header.type === 'orderbook.increment') {
                  
                  const bidCount = data.bids.length;
                  const askCount = data.asks.length;
                  const totalCount = bidCount + askCount;
                  
                  batchSize.add(totalCount);

                  if (lastIncrementTime > 0) {
                      const delta = now - lastIncrementTime;
                      
                      if (delta < 5000) {
                          incrementInterval.add(delta);

                          if (bidCount > 0 && askCount > 0) {
                              log(`📦 MIXED BATCH! Size: ${totalCount} (Bids:${bidCount} Asks:${askCount}) | Delta: ${delta}ms`, "SUCCESS");
                          } else if (totalCount > 1) {
                              const type = bidCount > 0 ? "Bids" : "Asks";
                              log(`📦 Same-Side Batch (${type}). Size: ${totalCount} | Delta: ${delta}ms`, "BATCH");
                          }
                      }
                  }
                  lastIncrementTime = now;
              }
          }
      });
    });
    
    socket.on('error', function(e) {
        if (e.error() != "websocket: close 1000 (normal)") {
            log(`WS Error: ${e.error()}`, "ERROR");
        }
    });
  });
}