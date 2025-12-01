import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// --- CONFIGURATION ---
const BASE_URL = 'https://api.uat.assetum.neodax.app';
const WS_URL = 'wss://api.uat.assetum.neodax.app/ws';

// Load users
const users = new SharedArray('users', function () {
  return JSON.parse(open('./users.json'));
});

// --- METRICS ---
const timeToCancelAck = new Trend('time_to_cancel_ack');
const timeToBalanceUnlock = new Trend('time_to_balance_unlock');

export const options = {
  vus: 10,
  duration: '10s', 
};

export default function () {
  const userIndex = (__VU - 1) % users.length;
  const currentUser = users[userIndex];
  
  const JWT_TOKEN = currentUser.jwt;
  const APP_SESSION_ID = currentUser.sessionId;

  // Track state
  const eventsReceived = {
      subscriptionConfirmed: false, 
      orderCreated: false,
      cancelSent: false,
      cancelDone: false,
      balanceUnlocked: false
  };

  // 2. OPEN WEBSOCKET CONNECTION
  const response = ws.connect(WS_URL, {}, function (socket) {
    
    let orderUuid = null;
    let cancelStartTime = null;

    // Helper to finish test
    function checkFinished() {
        if (eventsReceived.cancelDone && eventsReceived.balanceUnlocked) {
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

        // --- STEP A: SUBSCRIPTION CONFIRMED -> CREATE ORDER -> WAIT -> CANCEL ---
        if (msg.id === 1 && msg.connect && !eventsReceived.orderCreated) {
          eventsReceived.subscriptionConfirmed = true; 
          
          // 1. Create a Limit Order (Price 0.5 to avoid instant match)
          const payload = JSON.stringify({
            "app_session_id": APP_SESSION_ID,
            "market": "ETHYTEST.USD",
            "side": "buy",
            "amount": "0.001",
            "price": "0.5", 
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
          
          if (res.status === 200) {
            orderUuid = res.json('order_uuid');
            console.log(`VU ${__VU}: Order Created ${orderUuid}`);
            eventsReceived.orderCreated = true;

            // --- 2. WAIT (The fix for timeouts) ---
            console.log(`VU ${__VU}: Waiting 1s before cancelling...`);
            sleep(1);

            // --- 3. TRIGGER CANCEL ---
            const cancelPayload = JSON.stringify({
                "app_session_id": APP_SESSION_ID,
                "market": "ETHYTEST.USD",
                "order_uuid": orderUuid
            });

            const headers = {
                'Authorization': `Bearer ${JWT_TOKEN}`,
                'Content-Type': 'application/json',
            };

            // START TIMER
            cancelStartTime = Date.now(); 
            
            // SEND DELETE REQUEST
            const delRes = http.del(`${BASE_URL}/spot/order`, cancelPayload, { headers: headers });

            // DEBUG: Log the result of the cancel request
            if (delRes.status === 200) {
                eventsReceived.cancelSent = true;
                console.log(`VU ${__VU}: Cancel Req Sent. Status 200.`);
                
                try {
                    const body = delRes.json();
                    if (body.order_uuid && body.order_uuid !== orderUuid) {
                        console.warn(`VU ${__VU}: Cancel Response UUID mismatch!`);
                    }
                } catch(e) { /* ignore */ }

            } else {
                console.error(`VU ${__VU}: Cancel Request Failed! Status: ${delRes.status} Body: ${delRes.body}`);
                socket.close();
            }

          } else {
            console.error(`VU ${__VU}: Create Failed ${res.status} ${res.body}`);
            socket.close();
          }
        }

        // --- STEP B: LISTEN FOR WS EVENTS ---
        if (msg.push && msg.push.pub && msg.push.pub.data) {
            
            const data = msg.push.pub.data;
            const now = Date.now();

            // 1. CHECK FOR CANCELLATION EVENT
            if (data.header && data.header.type === 'order.cancelled') {
                if (data.uuid === orderUuid) {
                    if (data.state === 'canceled' && !eventsReceived.cancelDone) {
                        const duration = now - cancelStartTime;
                        timeToCancelAck.add(duration);
                        eventsReceived.cancelDone = true;
                        checkFinished();
                    }
                }
            }

            // 2. CHECK FOR BALANCE UNLOCK
            if (data.header && data.header.type === 'spot_account.balance_update') {
                if (data.app_session_id === APP_SESSION_ID) {
                     // Ensure we only count this AFTER we sent the cancel
                    if (eventsReceived.cancelSent && !eventsReceived.balanceUnlocked) {
                        const duration = now - cancelStartTime;
                        timeToBalanceUnlock.add(duration);
                        eventsReceived.balanceUnlocked = true;
                        checkFinished();
                    }
                }
            }
        }
      } catch (e) {
        // Ignore parsing errors
      }
    });

    socket.setTimeout(function () {
      if (!eventsReceived.cancelDone) {
          console.log(`VU ${__VU}: Timeout waiting for cancel. Order: ${orderUuid}`);
      }
      socket.close();
    }, 8000); 
  });

  // --- FINAL CHECKS ---
  check(eventsReceived, {
      'Order Created': (e) => e.orderCreated === true,
      'Cancel API 200 OK': (e) => e.cancelSent === true,
      'WS Cancel Event': (e) => e.cancelDone === true,
      'WS Balance Unlock': (e) => e.balanceUnlocked === true
  });

  sleep(1);
}