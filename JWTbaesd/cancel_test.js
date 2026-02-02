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
  vus: 2,
  duration: '20s', // Increased duration slightly to allow for event cycles
};

export default function () {
  const userIndex = (__VU - 1) % users.length;
  const currentUser = users[userIndex];
  
  const JWT_TOKEN = currentUser.jwt;
  const APP_SESSION_ID = currentUser.sessionId;

  // Track state
  const eventsReceived = {
      connected: false,
      subscriptionConfirmed: false, 
      orderCreated: false,
      cancelSent: false,
      cancelDone: false,
      balanceUnlocked: false
  };

  const response = ws.connect(WS_URL, {}, function (socket) {
    
    let orderUuid = null;
    let cancelStartTime = null;

    function checkFinished() {
        if (eventsReceived.cancelDone && eventsReceived.balanceUnlocked) {
            socket.close();
        }
    }

    // 1. LISTEN FOR CONNECTION ERRORS
    socket.on('open', function() {
        eventsReceived.connected = true;
        socket.send(JSON.stringify({
            "connect": { "token": JWT_TOKEN, "name": "js" },
            "id": 1
        }));
    });

    socket.on('close', function(code) {
        if (!eventsReceived.cancelDone) {
            console.warn(`VU ${__VU}: WS Closed unexpectedly. Code: ${code}`);
        }
    });

    socket.on('error', function(e) {
        console.error(`VU ${__VU}: WS Error: ${e.error()}`);
    });

    socket.on('message', function (message) {
      try {
        const msg = JSON.parse(message);

        // --- STEP A: SUBSCRIPTION CONFIRMED -> CREATE ORDER ---
        if (msg.id === 1 && msg.connect && !eventsReceived.orderCreated) {
          eventsReceived.subscriptionConfirmed = true; 
          
          // 1. Create a Limit Order
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
            console.log(`VU ${__VU}: Order Created ${orderUuid}. Waiting for WS update...`);
            eventsReceived.orderCreated = true;
          } else {
            console.error(`VU ${__VU}: Create Failed ${res.status}`);
            socket.close();
          }
        }

        // --- EVENTS LISTENER ---
        if (msg.push && msg.push.pub && msg.push.pub.data) {
            const data = msg.push.pub.data;
            const now = Date.now();

            // --- STEP B: TRIGGER CANCEL (On Order Update) ---
            // We wait for the first "order.updated" event for our UUID.
            // This confirms the engine has processed the order and it's safe to cancel.
            if (data.header && data.header.type === 'order.updated') {
                if (data.uuid === orderUuid && !eventsReceived.cancelSent) {
                    console.log(`VU ${__VU}: Order Update received. Triggering Cancel...`);
                    
                    const cancelPayload = JSON.stringify({
                        "app_session_id": APP_SESSION_ID,
                        "market": "ETHYTEST.USD",
                        "order_uuid": orderUuid
                    });
        
                    const headers = {
                        'Authorization': `Bearer ${JWT_TOKEN}`,
                        'Content-Type': 'application/json',
                    };
        
                    // START TIMER FOR CANCELLATION METRICS
                    cancelStartTime = Date.now(); 
                    
                    const delRes = http.del(`${BASE_URL}/spot/order`, cancelPayload, { headers: headers });
        
                    if (delRes.status === 200) {
                        eventsReceived.cancelSent = true;
                        console.log(`VU ${__VU}: Cancel Req Sent. Status 200.`);
                    } else {
                        console.error(`VU ${__VU}: Cancel Request Failed! Status: ${delRes.status}`);
                        socket.close();
                    }
                }
            }

            // --- STEP C: CHECK FOR CANCELLATION CONFIRMATION ---
            if (data.header && data.header.type === 'order.cancelled') {
                if (data.uuid === orderUuid && data.state === 'canceled' && !eventsReceived.cancelDone) {
                    const duration = now - cancelStartTime;
                    timeToCancelAck.add(duration);
                    eventsReceived.cancelDone = true;
                    checkFinished();
                }
            }

            // --- STEP D: CHECK FOR BALANCE UNLOCK ---
            if (data.header && data.header.type === 'spot_account.balance_update') {
                if (data.app_session_id === APP_SESSION_ID) {
                    // Only count balance updates that happen AFTER we initiated cancellation
                    if (eventsReceived.cancelSent && !eventsReceived.balanceUnlocked) {
                        const duration = now - cancelStartTime;
                        timeToBalanceUnlock.add(duration);
                        eventsReceived.balanceUnlocked = true;
                        checkFinished();
                    }
                }
            }
        }
      } catch (e) {}
    });

    socket.setTimeout(function () {
      if (eventsReceived.connected && !eventsReceived.cancelDone) {
          console.log(`VU ${__VU}: Timeout waiting for cancel.`);
      }
      socket.close();
    }, 8000); 
  });

  // --- FINAL CHECKS ---
  check(response, { 'WS Handshake Success': (r) => r && r.status === 101 });

  if (eventsReceived.connected) {
      check(eventsReceived, {
          'Order Created': (e) => e.orderCreated === true,
          'Cancel Sent': (e) => e.cancelSent === true,
          'WS Cancel Ack': (e) => e.cancelDone === true,
          'WS Balance Unlock': (e) => e.balanceUnlocked === true
      });
  }

  //sleep(1);
}