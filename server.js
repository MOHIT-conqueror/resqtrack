// ================== IMPORTS ==================
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ================== BASIC SETUP ==================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================== GEMINI SETUP ==================
// ⚠️ Note: In a production environment, use process.env.GEMINI_API_KEY
const genAI = new GoogleGenerativeAI("ask_me_for_key");

// ================== MONGODB ==================
const mongoUrl = "ask_me_for_key";

const client = new MongoClient(mongoUrl, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db, teamsCollection;

async function connectToMongo() {
    try {
        await client.connect();
        console.log("✅ MongoDB Connected");
        db = client.db("resqtrack");
        teamsCollection = db.collection("teams");
    } catch (err) {
        console.error("❌ MongoDB Error:", err);
        process.exit(1);
    }
}

// ================== WEBSOCKET ==================
let clients = new Map(); // teamId -> ws

wss.on('connection', (ws) => {
    console.log("🔌 Client connected");

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 🔹 REGISTER CLIENT
            if (data.type === "REGISTER") {
                ws.teamId = data.teamId;
                clients.set(data.teamId, ws);
                console.log("Registered:", data.teamId);
                return;
            }

            // 🔹 CHAT MESSAGE
            if (data.type === "CHAT_MESSAGE") {
                const { senderId, receiverId, text, time } = data;

                const payload = JSON.stringify({
                    type: "CHAT_MESSAGE",
                    senderId,
                    receiverId,
                    text,
                    time
                });

                // ✅ Send to receiver
                const receiver = clients.get(receiverId);
                if (receiver && receiver.readyState === WebSocket.OPEN) {
                    receiver.send(payload);
                }

                // ✅ ALSO send back to sender (important)
                ws.send(payload);
            }

        } catch (err) {
            console.error("WS ERROR:", err);
        }
    });

    ws.on('close', () => {
        if (ws.teamId) clients.delete(ws.teamId);
    });
});

// ================== BROADCAST FUNCTION ==================
// This function fetches the latest data and pushes it to all connected clients
async function broadcastUpdate() {
    try {
        const teams = await teamsCollection.find({}).toArray();
        const payload = JSON.stringify({
            type: 'INVENTORY_UPDATE',
            payload: teams
        });

        // Broadcast to all connected WebSocket clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    } catch (err) {
        console.error("Error broadcasting update:", err);
    }
}
// ================== API ROUTES ==================


// 🔹 SECURE AI ROUTE
app.post("/api/ai", async (req, res) => {
    try {
        const { history, systemPrompt } = req.body;

        if (!history || history.length === 0) {
            return res.status(400).json({ error: "Chat history required" });
        }

        // Initialize model with system instructions
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            systemInstruction: systemPrompt 
        });

        // Pop the latest user message off the history to send it
        const latestMessage = history.pop().parts[0].text;

        // Format history for the Gemini SDK
        const formattedHistory = history.map(msg => ({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: [{ text: msg.parts[0].text }]
        }));

        // Start chat
        const chat = model.startChat({
            history: formattedHistory,
            generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
        });

        const result = await chat.sendMessage(latestMessage);
        const text = result.response.text();

        res.json({ reply: text });

    } catch (err) {
        console.error("AI ERROR:", err.message);
        res.status(500).json({ error: "AI failed to generate response." });
    }
});

// 🔹 GET ALL DATA
app.get('/api/initial-data', async (req, res) => {
    const teams = await teamsCollection.find({}).toArray();
    res.json({ teams });
});

// 🔹 LOGIN
app.post('/api/login', async (req, res) => {
    const { accessKey } = req.body;
    const team = await teamsCollection.findOne({ accessKey });

    if (!team) {
        return res.status(401).json({ error: "Invalid key" });
    }

    const { accessKey: key, ...teamData } = team;
    res.json({ success: true, team: teamData });
});

// 🔹 DEPLOY TEAM
app.post('/api/deploy', async (req, res) => {
    const { name, location } = req.body;

    if (!name || !location) {
        return res.status(400).json({ error: "Missing fields" });
    }

    const newTeam = {
        _id: new ObjectId().toHexString(),
        name,
        location,
        accessKey: Math.floor(100000 + Math.random() * 900000).toString(),
        inventory: [
            { itemId: new ObjectId().toHexString(), name: 'Food', quantity: 100, threshold: 20 },
            { itemId: new ObjectId().toHexString(), name: 'Water', quantity: 200, threshold: 50 }
        ]
    };

    await teamsCollection.insertOne(newTeam);
    await broadcastUpdate();

    res.json({ success: true, accessKey: newTeam.accessKey });
});

// 🔹 DELETE TEAM
app.delete('/api/delete-team/:teamId', async (req, res) => {
    const { teamId } = req.params;
    const result = await teamsCollection.deleteOne({ _id: teamId });

    if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Not found" });
    }

    await broadcastUpdate();
    res.json({ success: true });
});

// 🔹 ADD INVENTORY
app.post('/api/inventory/add/:teamId', async (req, res) => {
    const { teamId } = req.params;
    const { name, quantity, threshold } = req.body;

    const item = {
        itemId: new ObjectId().toHexString(),
        name,
        quantity: parseInt(quantity),
        threshold: parseInt(threshold)
    };

    await teamsCollection.updateOne(
        { _id: teamId },
        { $push: { inventory: item } }
    );

    await broadcastUpdate();
    res.json({ success: true });
});

// 🔹 DELETE INVENTORY
app.delete('/api/inventory/delete/:teamId/:itemId', async (req, res) => {
    const { teamId, itemId } = req.params;

    await teamsCollection.updateOne(
        { _id: teamId },
        { $pull: { inventory: { itemId } } }
    );

    await broadcastUpdate();
    res.json({ success: true });
});

// 🔹 UPDATE INVENTORY (Missing in your original file, required for resupply/distribute buttons)
app.post('/api/update', async (req, res) => {
    const { teamId, itemId, amount } = req.body;

    try {
        await teamsCollection.updateOne(
            { _id: teamId, "inventory.itemId": itemId },
            { $inc: { "inventory.$.quantity": amount } }
        );
        await broadcastUpdate();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update inventory" });
    }
});

// ================== START SERVER ==================
const PORT = 3000;

connectToMongo().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
});
