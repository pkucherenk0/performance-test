// Last version that should support unlimited users from Json file

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { config, users } from './config.js';

// --- CONFIGURATION (env-driven; see config.js) ---
const BASE_URL = config.baseUrl;
const WS_URL = config.wsUrl;
const MARKET = config.spotMarket;
const BASE_ASSET = config.baseAsset;
const QUOTE_ASSET = config.quoteAsset;

// --- METRICS ---
const timeToTradeDone = new Trend('time_to_trade_done');
const timeToBalanceETH = new Trend('time_to_balance_eth');
const timeToBalanceUSD = new Trend('time_to_balance_usd');

export const options = {
  vus: 2, // Should match the number of users in your JSON file (or be a multiple)
  duration: '60s', 
};

export default function () {
  // 1. GET USER CREDENTIALS
  // Cycle through the users list based on the Virtual User ID (__VU)
  const userIndex = (__VU - 1) % users.length;
  const currentUser = users[userIndex];
  
  const JWT_TOKEN = currentUser.jwt;
  const APP_SESSION_ID = currentUser.sessionId;

  // Track state
  const eventsReceived = {
      subscriptionConfirmed: false, 
      tradeDone: false,
      balanceETH: false,
      balanceUSD: false
  };

  // 2. OPEN WEBSOCKET CONNECTION
  const response = ws.connect(WS_URL, {}, function (socket) {
    
    let orderUuid = null;
    let startTime = null;
    let orderSent = false;
    let usdUpdateCount = 0; 

    function checkFinished() {
        if (eventsReceived.tradeDone && eventsReceived.balanceETH && eventsReceived.balanceUSD) {
            socket.close();
        }
    }

    socket.on('open', function open() {
      const authMessage = JSON.stringify({
        "connect": { "token": JWT_TOKEN, "name": "js" },
        "id": 1
      });
      socket.send(authMessage);
    });

    socket.on('message', function (message) {
      try {
        const msg = JSON.parse(message);

        // --- A. CONFIRM SUBSCRIPTION & SEND ORDER ---
        if (msg.id === 1 && msg.connect && !orderSent) {
          eventsReceived.subscriptionConfirmed = true; 
          orderSent = true;

          const payload = JSON.stringify({
            "app_session_id": APP_SESSION_ID,
            "market": MARKET,
            "side": "buy",
            "amount": "0.00000001",
            //"price": "2000", 
            "type": "market",
            "time_in_force": "ioc"
          });
    
          const params = {
            headers: {
              'Authorization': `Bearer ${JWT_TOKEN}`,
              'Content-Type': 'application/json',
            },
          };
    
          const res = http.post(`${BASE_URL}/spot/order`, payload, params);
          const success = check(res, { 'API status is 200': (r) => r.status === 200 });
    
          if (success) {
            try {
                const body = res.json();
                orderUuid = body.order_uuid;
                startTime = Date.now(); // <--- CLOCK STARTS HERE
            } catch (e) {
                console.error(`VU ${__VU}: Failed to parse API JSON:`, res.body);
                socket.close();
            }
          } else {
            console.error(`VU ${__VU}: API Failed: ${res.status} ${res.body}`);
            socket.close();
          }
        }

        // --- B. LISTEN FOR EVENTS ---
        if (msg.push && msg.push.pub && msg.push.pub.data) {
            
            // CRITICAL CHECK: Ignore messages if order hasn't been placed yet
            if (!startTime) return;

            const data = msg.push.pub.data;
            const now = Date.now();

            // 1. CHECK FOR TRADE EXECUTION
            if (data.header && data.header.type === 'order.updated' && data.order_id
 === orderUuid) {
                if (data.state === 'done' && !eventsReceived.tradeDone) {
                    const duration = now - startTime;
                    timeToTradeDone.add(duration);
                    eventsReceived.tradeDone = true;
                    checkFinished();
                }
            }

            // 2. CHECK FOR BALANCE UPDATES
            if (data.header && data.header.type === 'spot_account.balance_update') {
                if (data.app_session_id === APP_SESSION_ID) {
                    
                    if (data.asset_symbol === BASE_ASSET && !eventsReceived.balanceETH) {
                        const duration = now - startTime;
                        timeToBalanceETH.add(duration);
                        eventsReceived.balanceETH = true;
                        checkFinished();
                    }

                    if (data.asset_symbol === QUOTE_ASSET) {
                        usdUpdateCount++;
                        if (usdUpdateCount === 2 && !eventsReceived.balanceUSD) {
                            const duration = now - startTime;
                            timeToBalanceUSD.add(duration);
                            eventsReceived.balanceUSD = true;
                            checkFinished();
                        }
                    }
                }
            }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    });

    socket.setTimeout(function () {
      socket.close();
    }, 8000); 
  });

  // --- FINAL CHECKS ---
  check(eventsReceived, {
      'Private Channel Subscribed': (e) => e.subscriptionConfirmed === true,
      'Order Execution Flow': (e) => e.tradeDone === true,
      'Full Balance Sync': (e) => e.balanceETH === true && e.balanceUSD === true
  });

  //sleep(1);
}