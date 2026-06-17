const crypto = require('crypto');

// --- 1. CONFIGURATION ---
// Provide credentials via environment variables (never commit real keys):
//   API_KEY=... API_SECRET=... DOMAIN=api.uat.yellow.pro.neodax.app node generate_wscat.js
const API_KEY = process.env.API_KEY || "YOUR_API_KEY";
const API_SECRET = process.env.API_SECRET || "YOUR_API_SECRET";

// The Connection Details
const DOMAIN = process.env.DOMAIN || "api.uat.yellow.pro.neodax.app";
const PATH = "/ws"; // <--- THIS is what we sign
const FULL_URL = `wss://${DOMAIN}${PATH}`; // <--- THIS is where we connect

// --- 2. GENERATE SIGNATURE ---
// Formula matches your working k6 script: GET + PATH + TIMESTAMP
const timestamp = Math.floor(Date.now() / 1000).toString(); // Seconds
const method = "GET";
const prehash = method + PATH + timestamp;

const signature = crypto.createHmac('sha256', API_SECRET)
    .update(prehash)
    .digest('hex');

// --- 3. PRINT DEBUG INFO ---
console.log("\n🔍 DEBUG INFO:");
console.log(`Prehash String: "${prehash}"`);
console.log(`Signature:      ${signature.substring(0, 10)}...`);

// --- 4. PRINT WSCAT COMMAND ---
console.log("\n🚀 RUN THIS COMMAND (Valid for ~60s):");
console.log(`wscat -c ${FULL_URL} -H "X-API-KEY: ${API_KEY}" -H "X-TIMESTAMP: ${timestamp}" -H "X-SIGNATURE: ${signature}"`);