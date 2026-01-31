const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    try {
      serviceAccount = require("./serviceAccountKey.json");
    } catch (e) {
      console.log("serviceAccountKey.json not found, waiting for Env Var...");
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase initialized successfully");
  }
} catch (error) {
  console.log("⚠️ Firebase initialization failed:", error.message);
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check route
app.get("/", (req, res) => {
  res.send("🚀 FCM Server is running and ready!");
});

app.post("/send-notification", async (req, res) => {
  try {
    const { topic, title, body } = req.body;

    const message = {
      notification: { title, body },
      topic: topic,
    };

    await admin.messaging().send(message);

    res.status(200).send("Notification sent successfully");
  } catch (error) {
    res.status(500).send(error.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
