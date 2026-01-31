const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
