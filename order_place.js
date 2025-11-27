// Simpliest template I started with

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

// --- CONFIGURATION ---
const JWT_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIweDFlMTcwYjAwMENFYjFlZTBlNjI1YjFkMkNlMkIwZjczNDk5NERhYjYiLCJzZXNzaW9uX2lkIjoiMDBhZmY1OTktOTkwZC00YTk4LWE3NGItYWE2NzQwNWVkMmYwIiwiaXNzIjoibmVvZGF4LWF1dGgiLCJhdWQiOlsibmVvZGF4LWFwaSJdLCJleHAiOjE3NjQzMjQ4MTYsImlhdCI6MTc2NDIzODQxNiwianRpIjoiMDg4NGU3ZDgtOWRhOC00MTc0LWEwYTMtZDUwYWJhMjJmMzM1In0.YB95MDSaPZfMtyfTSzZxBJzhJtP1hFTcJ6UNkPk9gofUhfRXpNPGSZ-no93bnCHsTH9o4Ey9BVIuL3Y0IP6Cyw'; // <--- PASTE YOUR TOKEN HERE
const APP_SESSION_ID = '0x5aa1d7aa06c1d7918b0b2f90e0ba1e8191eab5db25b112b12c145af6dd61e0d0'; // <--- PASTE YOUR FIXED SESSION ID HERE
const BASE_URL = 'https://api.uat.assetum.neodax.app';
const WS_URL = 'wss://api.uat.assetum.neodax.app/ws';

// --- METRICS ---
// This is the specific clock we want to watch: Time from (HTTP 200) to (WS Event)
const timeToUpdateStatus = new Trend('time_to_update_status');

export const options = {
  vus: 1,       // Start with 1 user to verify logic
  duration: '10s', 
};

export default function () {
  // 1. OPEN WEBSOCKET CONNECTION
  // We connect *before* the HTTP request so we don't miss the event.
  const response = ws.connect(WS_URL, {}, function (socket) {
    
    let orderUuid = null;
    let startTime = null;
    let orderSent = false; // Flag to ensure we only send the order once

    socket.on('open', function open() {
      console.log('1. WebSocket Connected');

      // 2. SEND WS AUTH MESSAGE
      // As per your requirement Step 5
      const authMessage = JSON.stringify({
        "connect": {
          "token": JWT_TOKEN,
          "name": "js"
        },
        "id": 1
      });
      socket.send(authMessage);
      console.log('2. WS Auth Sent. Waiting for confirmation...');
    });

    // 5. LISTEN FOR EVENTS (Handles both Subscription Confirmation AND Order Updates)
    socket.on('message', function (message) {
      // Step 6: Parse incoming WS messages
      try {
        const msg = JSON.parse(message);

        // --- CHECK 1: CONFIRM SUBSCRIPTION ---
        // We look for {"id":1, "connect": {...}}
        if (msg.id === 1 && msg.connect && !orderSent) {
          console.log('3. Subscription Confirmed! (Private channel ready)');
          orderSent = true;

          // NOW it is safe to send the HTTP Request
          const payload = JSON.stringify({
            "app_session_id": APP_SESSION_ID,
            "market": "ETHYTEST.USD",
            "side": "buy",
            "amount": "0.001",
            "price": "1",
            "type": "limit",
            "time_in_force": "gtc"
          });
    
          const params = {
            headers: {
              'Authorization': `Bearer ${JWT_TOKEN}`,
              'Content-Type': 'application/json',
            },
          };
    
          console.log('4. Sending HTTP POST Order...');
          const res = http.post(`${BASE_URL}/spot/order`, payload, params);
    
          // Check if API worked
          const success = check(res, { 'API status is 200': (r) => r.status === 200 });
    
          if (success) {
            // START TIMER & CAPTURE UUID
            try {
                const body = res.json();
                orderUuid = body.order_uuid;
                startTime = Date.now(); // <--- CLOCK STARTS HERE
                console.log(`5. Order Created! UUID: ${orderUuid}. Waiting for WS...`);
            } catch (e) {
                console.error('Failed to parse API JSON:', res.body);
                socket.close();
            }
          } else {
            console.error(`API Failed: ${res.status} ${res.body}`);
            socket.close();
          }
        }

        // --- CHECK 2: ORDER UPDATE EVENT ---
        // We need to safely check deep properties: push -> pub -> data -> uuid
        // If the structure matches your example:
        if (msg.push && msg.push.pub && msg.push.pub.data) {
            const data = msg.push.pub.data;

            // Check if this event belongs to OUR order
            if (data.uuid === orderUuid) {
                // 6. STOP TIMER
                const endTime = Date.now();
                const duration = endTime - startTime;
                
                // Record the data point
                timeToUpdateStatus.add(duration);
                
                console.log(`✓ SUCCESS: Order status update received in ${duration}ms`);
                
                // We got what we wanted, close the socket to finish this user's iteration
                socket.close(); 
            }
        }
      } catch (e) {
        // Ignore non-JSON messages (like ping/pong heartbeats)
      }
    });

    // Safety: Kill connection if event never arrives (timeout)
    socket.setTimeout(function () {
      console.log('x TIMEOUT: WS event never arrived');
      socket.close();
    }, 8000); // Wait 8 seconds max
  });

  check(response, { 'WS Handshake success': (r) => r && r.status === 101 });
}