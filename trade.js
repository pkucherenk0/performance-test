// Template that worksonly with one user (vus)

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

// --- CONFIGURATION ---
const JWT_TOKEN = 'JWT_TOKEN'; // <--- PASTE YOUR TOKEN HERE
const APP_SESSION_ID = 'APP_SESSION_ID'; // <--- PASTE YOUR FIXED SESSION ID HERE
const BASE_URL = 'https://api.uat.assetum.neodax.app';
const WS_URL = 'wss://api.uat.assetum.neodax.app/ws';

// --- METRICS ---
const timeToTradeDone = new Trend('time_to_trade_done');
const timeToBalanceETH = new Trend('time_to_balance_eth');
const timeToBalanceUSD = new Trend('time_to_balance_usd');

export const options = {
  vus: 1,
  duration: '10s', 
};

export default function () {
  // We define the state OUTSIDE the connection so we can verify it even if the connection closes early
  const eventsReceived = {
      subscriptionConfirmed: false, // NEW: Track if auth/sub actually succeeded
      tradeDone: false,
      balanceETH: false,
      balanceUSD: false
  };

  // 1. OPEN WEBSOCKET CONNECTION
  const response = ws.connect(WS_URL, {}, function (socket) {
    
    let orderUuid = null;
    let startTime = null;
    let orderSent = false;
    let usdUpdateCount = 0; // Track how many USD updates we received

    // Helper to check if we are finished
    function checkFinished() {
        if (eventsReceived.tradeDone && eventsReceived.balanceETH && eventsReceived.balanceUSD) {
            console.log('✓ ALL EVENTS RECEIVED. Test finished successfully.');
            socket.close();
        }
    }

    socket.on('open', function open() {
      console.log('1. WebSocket Connected');
      const authMessage = JSON.stringify({
        "connect": { "token": JWT_TOKEN, "name": "js" },
        "id": 1
      });
      socket.send(authMessage);
      console.log('2. WS Auth Sent. Waiting for confirmation...');
    });

    socket.on('message', function (message) {
      try {
        const msg = JSON.parse(message);

        // --- 1. CONFIRM SUBSCRIPTION & SEND ORDER ---
        if (msg.id === 1 && msg.connect && !orderSent) {
          console.log('3. Subscription Confirmed! Sending Order...');
          eventsReceived.subscriptionConfirmed = true; // Mark subscription as success
          orderSent = true;

          const payload = JSON.stringify({
            "app_session_id": APP_SESSION_ID,
            "market": "ETHYTEST.USD",
            "side": "buy",
            "amount": "0.00000001",
            "price": "2000", // Price to ensure instant match
            "type": "limit",
            "time_in_force": "gtc"
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
                console.log(`4. Order Created! UUID: ${orderUuid}. Waiting for trade & balances...`);
            } catch (e) {
                console.error('Failed to parse API JSON:', res.body);
                socket.close();
            }
          } else {
            console.error(`API Failed: ${res.status} ${res.body}`);
            socket.close();
          }
        }

        // --- 2. LISTEN FOR EVENTS ---
        if (msg.push && msg.push.pub && msg.push.pub.data) {
            const data = msg.push.pub.data;
            const now = Date.now();

            // A) CHECK FOR TRADE EXECUTION (order.updated -> done)
            // We check matching header type AND matching UUID
            if (data.header && data.header.type === 'order.updated' && data.uuid === orderUuid) {
                if (data.state === 'done' && !eventsReceived.tradeDone) {
                    const duration = now - startTime;
                    timeToTradeDone.add(duration);
                    eventsReceived.tradeDone = true;
                    console.log(`> Trade Executed (DONE) in ${duration}ms`);
                    checkFinished();
                }
            }

            // B) CHECK FOR BALANCE UPDATES (spot_account.balance_update)
            // We match based on session_id (if available) or just symbol/type since we are the only user
            if (data.header && data.header.type === 'spot_account.balance_update') {
                
                // Optional: Check if app_session_id matches to be 100% sure it's our trade
                if (data.app_session_id === APP_SESSION_ID) {
                    
                    if (data.asset_symbol === 'ETH' && !eventsReceived.balanceETH) {
                        const duration = now - startTime;
                        timeToBalanceETH.add(duration);
                        eventsReceived.balanceETH = true;
                        console.log(`> ETH Balance Updated in ${duration}ms`);
                        checkFinished();
                    }

                    if (data.asset_symbol === 'YTEST.USD') {
                        usdUpdateCount++;
                        console.log(`> USD Balance Update ${usdUpdateCount}/2 received`);

                        // We wait specifically for the 2nd update to mark USD as "finished"
                        if (usdUpdateCount === 2 && !eventsReceived.balanceUSD) {
                            const duration = now - startTime;
                            timeToBalanceUSD.add(duration);
                            eventsReceived.balanceUSD = true;
                            console.log(`> USD Balance Final Update (2/2) in ${duration}ms`);
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
      console.log('x TIMEOUT: Not all events arrived');
      socket.close();
    }, 8000); 
  });

  // --- FINAL CHECKS ---
  // If subscription fails, 'Private Channel Subscribed' will be FALSE (fail).
  // If order never updates, 'Order Execution Flow' will be FALSE (fail).
  // We removed the handshake check so it doesn't skew the results.
  check(eventsReceived, {
      'Private Channel Subscribed': (e) => e.subscriptionConfirmed === true,
      'Order Execution Flow': (e) => e.tradeDone === true,
      'Full Balance Sync': (e) => e.balanceETH === true && e.balanceUSD === true
  });

  // Short sleep to prevent hot-looping if connection fails instantly
  //sleep(1);
}