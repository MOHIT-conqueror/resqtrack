// Import necessary packages
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');

// --- Basic Setup ---
const app = express();
app.use(cors()); // Enable CORS for client-side access
app.use(express.json()); // Middleware to parse JSON body

// FIX: Serve static HTML files from the current directory
// This ensures client-server communication via http://localhost:3000.
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // WebSocket server setup

// --- MongoDB Setup ---
// IMPORTANT: Replace the line below with the connection string from your MongoDB Atlas account!
const mongoUrl = "mongodb://mohitthakur5885:test123@ac-mwnh30c-shard-00-00.hw4ce9m.mongodb.net:27017,ac-mwnh30c-shard-00-01.hw4ce9m.mongodb.net:27017,ac-mwnh30c-shard-00-02.hw4ce9m.mongodb.net:27017/?ssl=true&replicaSet=atlas-13l87m-shard-0&authSource=admin&appName=Cluster0"; // REPLACE WITH YOUR ACTUAL URL

const dbName = 'resqtrack';
const client = new MongoClient(mongoUrl, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db;
let teamsCollection;

// Function to generate a unique 6-digit key
const generateUniqueKey = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// NOTE: getValidId is only kept for legacy complex MongoDB queries, but is bypassed for the main _id field lookup in most operations.
const getValidId = (id) => {
    if (ObjectId.isValid(id)) {
        return new ObjectId(id);
    }
    return id; 
};

async function connectToMongo() {
    try {
        await client.connect();
        console.log('✅ Connected successfully to MongoDB Atlas server');
        db = client.db(dbName);
        teamsCollection = db.collection('teams');
        await insertInitialData(); // Check if initial data is needed
    } catch (err) {
        console.error('❌ Failed to connect to MongoDB. Check your connection string.', err);
        process.exit(1); 
    }
}

// Function is modified to skip insertion (no default teams)
const insertInitialData = async () => {
    const count = await teamsCollection.countDocuments();
    if (count === 0) {
        console.log("Database is empty. Ready for new team deployments."); 
    }
};

// --- WebSocket Logic ---
wss.on('connection', ws => {
    console.log('A new client connected');
    ws.on('close', () => console.log('Client disconnected'));
});

// Function to broadcast updates to all connected clients
const broadcastUpdate = async () => {
    try {
        const allTeamsData = await teamsCollection.find({}).toArray();
        const message = JSON.stringify({ type: 'INVENTORY_UPDATE', payload: allTeamsData });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
        console.log("🔄 Broadcasted update to all clients.");
    } catch (err) {
        console.error("Error broadcasting update:", err);
    }
};

// --- API Endpoints ---

// GET: Fetch all initial data
app.get('/api/initial-data', async (req, res) => {
    try {
        const allTeams = await teamsCollection.find({}).toArray();
        res.json({ teams: allTeams });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Login using access key
app.post('/api/login', async (req, res) => {
    const { accessKey } = req.body;
    try {
        const team = await teamsCollection.findOne({ accessKey });
        if (team) {
            const { accessKey: key, ...teamData } = team;
            res.json({ success: true, team: teamData });
        } else {
            res.status(401).json({ error: "Invalid access key" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Deploy new team
app.post('/api/deploy', async (req, res) => {
    const { name, location } = req.body;
    if (!name || !location) {
        return res.status(400).json({ error: "Team name and location are required." });
    }

    try {
        const newTeam = {
            _id: new ObjectId().toHexString(), 
            name,
            location,
            accessKey: generateUniqueKey(),
            inventory: [
                 { itemId: new ObjectId().toHexString(), name: 'MREs (Rations)', quantity: 150, threshold: 30 },
                 { itemId: new ObjectId().toHexString(), name: 'Tents (Shelter)', quantity: 20, threshold: 5 },
            ]
        };
        await teamsCollection.insertOne(newTeam);
        await broadcastUpdate();
        res.json({ success: true, accessKey: newTeam.accessKey });
    } catch (err) {
        console.error(`Error deploying team: ${err.message}`); 
        res.status(500).json({ error: `Database Error: ${err.message}` });
    }
});

// DELETE: Delete a team
app.delete('/api/delete-team/:teamId', async (req, res) => {
    const { teamId } = req.params;
    
    // FINAL FIX APPLIED: Use the raw string ID directly for deletion.
    try {
        const result = await teamsCollection.deleteOne({ _id: teamId });
        
        if (result.deletedCount === 0) {
            console.log(`Team not found with ID: ${teamId}`);
            return res.status(404).json({ error: "Team not found" });
        }
        await broadcastUpdate();
        res.json({ success: true, message: `Team ${teamId} deleted.` });
    } catch (err) {
        console.error(`Error deleting team ${teamId}:`, err);
        res.status(500).json({ error: `Database Error: ${err.message}` });
    }
});

// POST: Add new inventory item to a team
app.post('/api/inventory/add/:teamId', async (req, res) => {
    const { teamId } = req.params;
    const { name, quantity, threshold } = req.body;

    if (!name || isNaN(quantity) || isNaN(threshold) || quantity < 0 || threshold < 0) {
        return res.status(400).json({ error: "Invalid item data provided." });
    }

    // FINAL FIX APPLIED: Use the raw string ID directly for the query.
    try {
        const newItem = {
            itemId: new ObjectId().toHexString(),
            name,
            quantity: parseInt(quantity),
            threshold: parseInt(threshold)
        };

        const result = await teamsCollection.updateOne(
            { _id: teamId }, // Query using raw string ID
            { $push: { inventory: newItem } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: "Team not found." });
        }
        await broadcastUpdate();
        res.json({ success: true, message: `Item ${name} added.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE: Delete an inventory item from a team
app.delete('/api/inventory/delete/:teamId/:itemId', async (req, res) => {
    const { teamId, itemId } = req.params;

    // FINAL FIX APPLIED: Use the raw string ID directly for the query.
    try {
        const result = await teamsCollection.updateOne(
            { _id: teamId }, // Query using raw string ID
            { $pull: { inventory: { itemId: itemId } } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ error: "Team or item not found." });
        }
        await broadcastUpdate();
        res.json({ success: true, message: `Item ${itemId} deleted.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: Update inventory (Distribute/Resupply)
app.post('/api/update', async (req, res) => {
    const { teamId, itemId, amount } = req.body;
    
    // FINAL FIX APPLIED: Use the raw string ID directly for the query.
    try {
        const result = await teamsCollection.updateOne(
            { _id: teamId, "inventory.itemId": itemId }, // Query using raw string ID
            { $inc: { "inventory.$.quantity": amount } }
        );

        if (amount < 0) {
            await teamsCollection.updateOne(
                { _id: teamId, "inventory.itemId": itemId, "inventory.quantity": { $lt: 0 } }, // Query using raw string ID
                { $set: { "inventory.$.quantity": 0 } }
            );
        }

        if (result.modifiedCount > 0) {
            res.json({ success: true });
            await broadcastUpdate(); 
        } else {
            res.status(404).json({ error: "Inventory item not found for the team" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- Start Server ---
const PORT = 3000;
connectToMongo().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server is listening on http://localhost:${PORT}`);
        console.log("Open central_command.html and rescue_team.html in your browser.");
        
        console.log(`\n*** ACTION REQUIRED: Please open this link in your browser: http://localhost:${PORT}/central_command.html ***`);
    });
});