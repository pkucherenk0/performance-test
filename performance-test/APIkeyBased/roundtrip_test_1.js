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

// --- METRICS ---
const timeToOrderAck = new Trend('time_to_order_ack');       // First update (e.g. 'wait')
const timeToTradeDone = new Trend('time_to_trade_done');     // Final trade (e.g. 'done')
const timeToBalanceUpdate = new Trend('time_to_balance_update'); // Balance change

export const options = {
  vus: 1, 
  duration: '60s', 
};

// --- AUTH HELPER (MATCHING POSTMAN LOGIC) ---
function getAuthHeaders(apiKey, apiSecret, method, url, bodyObject = {}) {
    const timestamp = Math.floor(Date.now() / 1000).toString(); // Seconds
    
    let path = url.replace(/^(?:https?:\/\/|wss?:\/\/)[^\/]+/, "");
    if (!path.startsWith("/")) {
        path = "/" + path;
    }

    let canonicalFieldString = "";
    const methodUpper = method.toUpperCase();

    if (["POST", "PUT", "PATCH", "DELETE"].includes(methodUpper)) {
        try {
            const sortedKeys = Object.keys(bodyObject).sort();
            canonicalFieldString = sortedKeys.map(key => `${key}=${bodyObject[key]}`).join("|");
        } catch (e) {
            canonicalFieldString = "";
        }
    } 

    const prehash = methodUpper + path + timestamp + canonicalFieldString;
    const signature = crypto.hmac('sha256', apiSecret, prehash, 'hex');

    return {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
        'X-TIMESTAMP': timestamp,
        'X-SIGNATURE': signature
    };
}

export default function () {
  const userIndex = (__VU - 1) % users.length;
  const currentUser = users[userIndex];
  
  const APP_SESSION_ID = currentUser.sessionId;
  const API_KEY = currentUser.apiKey;
  const API_SECRET = currentUser.apiSecret;
  const USER_ADDRESS = currentUser.userAddress;

  if (!API_KEY || !API_SECRET) {
      console.error(`VU ${__VU}: Missing credentials in users.json`);
      return;
  }

  // State Tracking
  const state = {
      connected: false,
      handshakeSuccess: false, // {"connect":...} confirmed
      subscribed: false,       // {"subscribe":...} confirmed
      orderUuid: null,
      startTime: null,
      events: {
          ack: false,
          trade: false,
          balance: false
      }
  };

  // 1. GENERATE WS AUTH HEADERS
  const wsHeaders = getAuthHeaders(API_KEY, API_SECRET, 'GET', WS_URL, {});

  // 2. CONNECT WEBSOCKET
  const response = ws.connect(WS_URL, { headers: wsHeaders }, function (socket) {
    
    function checkFinished() {
        if (state.events.ack && state.events.trade && state.events.balance) {
            socket.close();
        }
    }

    socket.on('open', function() {
        state.connected = true;
        
        // 3. STEP 1: SEND CONNECT COMMAND (Centrifuge Protocol)
        const connectMsg = JSON.stringify({
            "id": 1,
            "connect": {}
        });
        socket.send(connectMsg);
    });

    socket.on('message', function (message) {
      try {
        const msg = JSON.parse(message);

        // 4. STEP 2: HANDLE CONNECT CONFIRMATION -> SEND ORDER
        if (msg.id === 1 && !state.handshakeSuccess) {
            if (msg.error) {
                console.error(`VU ${__VU}: Connect Failed: ${JSON.stringify(msg.error)}`);
                socket.close();
                return;
            }
            state.handshakeSuccess = true;
            state.subscribed = true; // Auto-subscription implied with API Key
            
            // Send Order via HTTP immediately after connection confirmation
            const payloadObj = {
                "app_session_id": APP_SESSION_ID,
                "market": MARKET,
                "side": "sell",
                "amount": "0.0001",
                "price": "2000",
                "type": "limit",
                "time_in_force": "gtc"
            };
            const orderUrl = `${BASE_URL}/spot/order`;
            const apiHeaders = getAuthHeaders(API_KEY, API_SECRET, 'POST', orderUrl, payloadObj);

            const res = http.post(orderUrl, JSON.stringify(payloadObj), { headers: apiHeaders });

            if (res.status === 200) {
                state.orderUuid = res.json('order_uuid');
                state.startTime = Date.now(); 
            } else {
                console.error(`VU ${__VU}: Order Failed ${res.status} ${res.body}`);
                socket.close();
            }
        }

        // 5. LISTEN FOR EVENTS
        if (msg.push && msg.push.pub && msg.push.pub.data) {
            const data = msg.push.pub.data;
            const now = Date.now();

            if (!state.startTime) return;

            // A) ORDER UPDATE EVENTS
            const eventOrderId = data.uuid || data.order_id;
            
            // We now listen for 'order.rejected' as well
            if (data.header && (data.header.type === 'order.updated' || data.header.type === 'order.rejected') && eventOrderId === state.orderUuid) {
                
                // CHECK FOR REJECTION (Balance Error or other)
                if (data.state === 'rejected' || data.state === 'canceled') {
                    const reason = data.reject_reason || "Unknown reason";
                    console.error(`VU ${__VU}: ❌ Order Rejected! Reason: ${reason}`);
                    // Close immediately so we don't wait for a trade that will never happen
                    socket.close();
                    return;
                }

                if (!state.events.ack) {
                    const duration = now - state.startTime;
                    timeToOrderAck.add(duration);
                    state.events.ack = true;
                }

                if (data.state === 'done' && !state.events.trade) {
                    const duration = now - state.startTime;
                    timeToTradeDone.add(duration);
                    state.events.trade = true;
                    checkFinished();
                }
            }

            // B) BALANCE UPDATE EVENTS
            if (data.header && data.header.type === 'spot_account.balance_update') {
                if (data.app_session_id === APP_SESSION_ID) {
                    if (!state.events.balance) {
                        const duration = now - state.startTime;
                        timeToBalanceUpdate.add(duration);
                        state.events.balance = true;
                        checkFinished();
                    }
                }
            }
        }
      } catch (e) {
          // ignore pings or non-json
      }
    });

    socket.on('close', function(code) {
        if (state.connected) {
            const missing = [];
            if (!state.events.ack) missing.push("Order Ack");
            if (!state.events.trade) missing.push("Trade Done");
            if (!state.events.balance) missing.push("Balance Update");

            if (missing.length > 0) {
                // Only log if it's an UNEXPECTED close (not 1000/1001 normal closure)
                // or if we missed events we were waiting for
                if (code !== 1000 && code !== 1001) {
                     console.error(`VU ${__VU}: WS Closed unexpectedly code ${code}`);
                }
            }
        }
    });

    socket.setTimeout(function () {
      if (state.connected) {
          socket.close(); 
      } else {
          // Log only if we never even connected
          console.error(`VU ${__VU}: WS Timeout - Connection never established`);
          socket.close();
      }
    }, 25000); 
  });

  // Only check handshake success if it wasn't a 101 switch protocol
  // Checking response.status === 101 covers most cases
  check(response, { 'WS Handshake Success': (r) => r && r.status === 101 });

  if (state.connected) {
      check(state.events, {
          'Connect Confirmed': (e) => state.handshakeSuccess === true,
          'Subscription Confirmed': (e) => state.subscribed === true,
          'Order Ack Received': (e) => e.ack === true,
          'Trade Done Received': (e) => e.trade === true,
          'Balance Update Received': (e) => e.balance === true
      });
  }
  
  //sleep(1);
}