const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require("./serviceAccountKey.json");
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase initialized");
} catch (error) {
  console.log("⚠️ Waiting for configuration...");
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("🚀 FCM Server is running and ready!"));

app.post("/send-notification", async (req, res) => {
  try {
    const { topic, title, body } = req.body;
    await admin.messaging().send({ notification: { title, body }, topic: topic });
    res.status(200).send("Notification sent successfully");
  } catch (error) {
    res.status(500).send(error.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
