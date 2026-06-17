const WebSocket = require('ws');
const crypto = require('crypto');
// --- 1. CONFIGURATION ---
// Provide credentials via environment variables (never commit real keys):
//   API_KEY=... API_SECRET=... USER_ADDRESS=0x... WS_URL=wss://... node wsconnect.js
const CONFIG = {
    apiKey: process.env.API_KEY || "YOUR_API_KEY",
    apiSecret: process.env.API_SECRET || "YOUR_API_SECRET",
    userAddress: process.env.USER_ADDRESS || "0xYOUR_ADDRESS", // Needed for subscription
    url: process.env.WS_URL || "wss://api.uat.yellow.pro.neodax.app/ws"
};
// --- 2. AUTH HELPER (Exact Match to Postman/K6) ---
function getAuthHeaders(apiKey, apiSecret, url) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Extract path (e.g., "/ws")
    const path = url.replace(/^(?:https?:\/\/|wss?:\/\/)[^\/]+/, "");
    // Canonical string is empty for WS handshake (GET with no params)
    const canonicalFieldString = "";
    // Prehash: METHOD + PATH + TIMESTAMP + CANONICAL
    const prehash = "GET" + path + timestamp + canonicalFieldString;
    // Sign
    const signature = crypto.createHmac('sha256', apiSecret)
        .update(prehash)
        .digest('hex');
    console.log(`[DEBUG] Timestamp: ${timestamp}`);
    console.log(`[DEBUG] Path: "${path}"`);
    console.log(`[DEBUG] Prehash: "${prehash}"`);
    console.log(`[DEBUG] Signature: ${signature}`);
    const headers = {
        'X-API-KEY': apiKey,
        'X-TIMESTAMP': timestamp,
        'X-SIGNATURE': signature,
        'Content-Type': 'application/json'
    };
    console.log(`[DEBUG] Headers:`, JSON.stringify(headers, null, 2));
    return headers;
}
// --- 3. MAIN LOGIC ---
function run() {
    console.log("Generating headers and connecting...");
    const headers = getAuthHeaders(CONFIG.apiKey, CONFIG.apiSecret, CONFIG.url);
    const ws = new WebSocket(CONFIG.url, { headers: headers });
    ws.on('open', function open() {
        console.log('✅ Connected! Sending Centrifuge connect...');
        const connectMsg = { connect: {}, id: 1 };
        console.log('📤 Sending:', JSON.stringify(connectMsg));
        ws.send(JSON.stringify(connectMsg));
    });
    ws.on('message', function message(data) {
        console.log('📩 Received:', data.toString());
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        // After connect reply (id:1), send subscribe
        if (msg.id === 1 && msg.connect !== undefined) {
            console.log('✅ Centrifuge connected! Subscribing...');
            const subMsg = {
                subscribe: { channel: "public.tickers.24h", flag: 1 },
                id: 2
            };
            console.log('📤 Sending:', JSON.stringify(subMsg));
            ws.send(JSON.stringify(subMsg));
        }
    });
    ws.on('close', function close(code, reason) {
        console.log(`❌ Disconnected. Code: ${code} Reason: ${reason}`);
    });
    ws.on('error', function error(err) {
        console.error('⚠️ Error:', err.message);
    });
}
run();