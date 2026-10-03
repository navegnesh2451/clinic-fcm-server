const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const nodemailer = require("nodemailer");
const functions = require("firebase-functions");
const multer = require("multer");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// CONFIGURATION: Replace with your actual SMTP details.
// For Gmail, use an "App Password"
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

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

// ---------------------------------------------------------------------------
// Supabase service-role client (server-side only). Initialized only when both
// env vars are present; otherwise X-ray endpoints return 503 and the app falls
// back to its previous direct public-bucket behavior (zero-downtime rollout).
// ---------------------------------------------------------------------------
const XRAY_BUCKET = "xrays";
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    console.log("✅ Supabase service client initialized");
  } catch (error) {
    console.log("⚠️ Supabase init failed:", error.message);
  }
} else {
  console.log(
    "ℹ️ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; X-ray proxy disabled (app will use legacy behavior)."
  );
}

// Uploads buffer in memory; images are forwarded straight to Supabase.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const app = express();

// ---------------------------------------------------------------------------
// CORS: restrict to trusted browser origins. Native (mobile/desktop) Dart
// clients send no Origin header, so they are always allowed here; the real
// protection for them is the ID-token guard below. Web origins can be extended
// without a code change via the ALLOWED_ORIGINS env var (comma separated).
// ---------------------------------------------------------------------------
const extraOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const defaultOrigins = [
  "https://clinic-fcm-server.onrender.com",
];
const isAllowedOrigin = (origin) => {
  // Non-browser clients (Flutter mobile/desktop, curl, server-to-server).
  if (!origin) return true;
  // Local development web builds.
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  const list = extraOrigins.length ? extraOrigins : defaultOrigins;
  return list.includes(origin);
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 3600,
  })
);
app.use(express.json());

// ---------------------------------------------------------------------------
// requireAuth: verify the caller's Firebase ID token (sent as
// `Authorization: Bearer <idToken>`). This is what actually closes the
// unauthenticated /send-email & /send-notification abuse vectors. The decoded
// token is attached to req.user for downstream use.
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!idToken) {
      return res
        .status(401)
        .json({ success: false, error: "Missing authentication token" });
    }
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (error) {
    return res
      .status(403)
      .json({ success: false, error: "Invalid or expired token" });
  }
}

// Health check route
app.get("/", (req, res) => {
  res.send("🚀 FCM Server is running and ready!");
});

app.post("/send-notification", requireAuth, async (req, res) => {
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

app.post("/send-email", requireAuth, async (req, res) => {
  try {
    const { patientEmail, patientName, date, time, doctor } = req.body;

    console.log(`Sending email to ${patientEmail} for appointment on ${date} at ${time}`);

    const mailOptions = {
      from: "Dental Clinic <" + (process.env.EMAIL_USER || "yourclinic@gmail.com") + ">",
      to: patientEmail,
      subject: "Appointment Confirmed 🦷",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #d4af37; border-radius: 12px; max-width: 500px;">
          <h2 style="color: #d4af37; text-align: center;">Appointment Confirmed</h2>
          <p>Hi <strong>${patientName}</strong>,</p>
          <p>Your visit to <strong>Dental Clinic</strong> has been scheduled successfully.</p>
          <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 5px 0;">📅 <strong>Date:</strong> ${date}</p>
              <p style="margin: 5px 0;">⏰ <strong>Time:</strong> ${time}</p>
              <p style="margin: 5px 0;">👨‍⚕️ <strong>Doctor:</strong> ${doctor}</p>
          </div>
          <p style="font-size: 13px; color: #666;">Please arrive 10 minutes early. If you need to reschedule, please call the clinic.</p>
          <p style="text-align: center; margin-top: 30px; color: #999; font-size: 12px;">© 2024 Dental Clinic Team</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ success: true, message: "Email sent" });
  } catch (error) {
    console.error("Email Error:", error);
    res.status(500).json({ success: false, error: error.toString() });
  }
});

// ============================================================================
// CLINIC-SCOPED X-RAY STORAGE PROXY
// ----------------------------------------------------------------------------
// The Supabase `xrays` bucket is (or will be) private. The app never talks to
// Supabase directly; it calls these endpoints with its Firebase ID token. We
// verify the token (requireAuth) and that the caller's clinic owns the patient
// before minting a short-lived signed URL or performing an upload/delete with
// the server-side service-role key.
// ============================================================================

// Resolve the set of clinic (doctor) UIDs the caller can access. Mirrors the
// getClinicId()/getConnectedDoctorId() logic in firestore.rules.
async function getClinicIds(uid) {
  const db = admin.firestore();
  const ids = new Set([uid]);
  const [userDoc, recDoc] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("receptionists").doc(uid).get(),
  ]);
  if (userDoc.exists) {
    const d = userDoc.data() || {};
    for (const f of ["adminId", "doctorId", "doctorUid", "connectedDoctorUid"]) {
      if (d[f]) ids.add(d[f]);
    }
  }
  if (recDoc.exists) {
    const d = recDoc.data() || {};
    if (d.isConnected === true && d.connectedDoctorUid) {
      ids.add(d.connectedDoctorUid);
    }
  }
  return ids;
}

// True only when the patient document exists and belongs to one of the
// caller's clinics.
async function authorizePatientAccess(uid, patientId) {
  if (!uid || !patientId) return false;
  const db = admin.firestore();
  const [clinicIds, patientDoc] = await Promise.all([
    getClinicIds(uid),
    db.collection("patients").doc(patientId).get(),
  ]);
  if (!patientDoc.exists) return false;
  const doctorId = patientDoc.data().doctorId;
  return !!doctorId && clinicIds.has(doctorId);
}

function extFromName(name) {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(name || "");
  return m ? m[0].toLowerCase() : ".jpg";
}

app.post("/xray-upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage proxy not configured" });
    }
    const { patientId, type } = req.body;
    if (!patientId || !req.file) {
      return res.status(400).json({ success: false, error: "patientId and file are required" });
    }
    const allowed = await authorizePatientAccess(req.user.uid, patientId);
    if (!allowed) {
      return res.status(403).json({ success: false, error: "Not authorized for this patient" });
    }
    const safeType = type === "old" ? "old" : "new";
    const ext = extFromName(req.file.originalname);
    const objectPath = `${patientId}/${safeType}/${crypto.randomUUID()}${ext}`;
    const { error } = await supabase.storage
      .from(XRAY_BUCKET)
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype || "image/jpeg",
        upsert: false,
      });
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    res.status(200).json({ success: true, path: objectPath });
  } catch (error) {
    console.error("X-ray upload error:", error);
    res.status(500).json({ success: false, error: error.toString() });
  }
});

app.get("/xray-url", requireAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage proxy not configured" });
    }
    const objectPath = req.query.path;
    if (!objectPath) {
      return res.status(400).json({ success: false, error: "path is required" });
    }
    const patientId = String(objectPath).split("/")[0];
    const allowed = await authorizePatientAccess(req.user.uid, patientId);
    if (!allowed) {
      return res.status(403).json({ success: false, error: "Not authorized" });
    }
    const { data, error } = await supabase.storage
      .from(XRAY_BUCKET)
      .createSignedUrl(objectPath, 60);
    if (error || !data) {
      return res.status(500).json({ success: false, error: (error && error.message) || "sign failed" });
    }
    res.status(200).json({ success: true, url: data.signedUrl });
  } catch (error) {
    console.error("X-ray url error:", error);
    res.status(500).json({ success: false, error: error.toString() });
  }
});

app.post("/xray-delete", requireAuth, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ success: false, error: "Storage proxy not configured" });
    }
    const objectPath = req.body.path;
    if (!objectPath) {
      return res.status(400).json({ success: false, error: "path is required" });
    }
    const patientId = String(objectPath).split("/")[0];
    const allowed = await authorizePatientAccess(req.user.uid, patientId);
    if (!allowed) {
      return res.status(403).json({ success: false, error: "Not authorized" });
    }
    const { error } = await supabase.storage.from(XRAY_BUCKET).remove([objectPath]);
    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("X-ray delete error:", error);
    res.status(500).json({ success: false, error: error.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

// ============================================================================
// FIRESTORE TRIGGERS FOR APPOINTMENT NOTIFICATIONS
// ============================================================================

/**
 * Triggered when a new appointment is created in Firestore
 * Sends push notification to all receptionists connected to the doctor
 */
exports.sendAppointmentNotification = functions.firestore
  .document('appointments/{appointmentId}')
  .onCreate(async (snap, context) => {
    try {
      console.log('🔔 New appointment created:', context.params.appointmentId);

      // Get appointment data
      const appointment = snap.data();
      const { patientName, time, doctorId } = appointment;

      if (!doctorId) {
        console.log('⚠️ No doctorId in appointment, skipping notification');
        return null;
      }

      console.log(`📋 Appointment details: Patient=${patientName}, Time=${time}, Doctor=${doctorId}`);

      // Query all receptionists connected to this doctor
      const receptionistsSnapshot = await admin.firestore()
        .collection('users')
        .where('role', '==', 'receptionist')
        .where('doctorId', '==', doctorId)
        .get();

      if (receptionistsSnapshot.empty) {
        console.log('⚠️ No receptionists found for this doctor');
        return null;
      }

      console.log(`👥 Found ${receptionistsSnapshot.size} receptionists`);

      // Collect all FCM tokens
      const tokens = [];
      receptionistsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.fcmToken) {
          tokens.push(data.fcmToken);
          console.log(`📱 Token for ${data.name}: ${data.fcmToken.substring(0, 20)}...`);
        }
      });

      if (tokens.length === 0) {
        console.log('⚠️ No FCM tokens found for receptionists');
        return null;
      }

      // Create multicast notification
      const message = {
        notification: {
          title: 'New Appointment',
          body: `Patient ${patientName} at ${time}`,
        },
        data: {
          appointmentId: context.params.appointmentId,
          doctorId: doctorId,
          type: 'new_appointment',
        },
        tokens: tokens,
      };

      // Send multicast notification
      const response = await admin.messaging().sendMulticast(message);

      console.log(`✅ Notification sent to ${response.successCount} devices`);
      if (response.failureCount > 0) {
        console.log(`❌ Failed to send to ${response.failureCount} devices`);
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            console.log(`❌ Token ${idx} failed: ${resp.error}`);
          }
        });
      }

      return null;
    } catch (error) {
      console.error('❌ Error sending appointment notification:', error);
      return null;
    }
  });

/**
 * Triggered when an appointment is updated in Firestore
 * Sends push notification to all receptionists connected to the doctor
 */
exports.updateAppointmentNotification = functions.firestore
  .document('appointments/{appointmentId}')
  .onUpdate(async (change, context) => {
    try {
      console.log('🔔 Appointment updated:', context.params.appointmentId);

      // Get updated appointment data
      const appointment = change.after.data();
      const { patientName, time, doctorId } = appointment;

      if (!doctorId) {
        console.log('⚠️ No doctorId in appointment, skipping notification');
        return null;
      }

      console.log(`📋 Updated appointment details: Patient=${patientName}, Time=${time}, Doctor=${doctorId}`);

      // Query all receptionists connected to this doctor
      const receptionistsSnapshot = await admin.firestore()
        .collection('users')
        .where('role', '==', 'receptionist')
        .where('doctorId', '==', doctorId)
        .get();

      if (receptionistsSnapshot.empty) {
        console.log('⚠️ No receptionists found for this doctor');
        return null;
      }

      console.log(`👥 Found ${receptionistsSnapshot.size} receptionists`);

      // Collect all FCM tokens
      const tokens = [];
      receptionistsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.fcmToken) {
          tokens.push(data.fcmToken);
          console.log(`📱 Token for ${data.name}: ${data.fcmToken.substring(0, 20)}...`);
        }
      });

      if (tokens.length === 0) {
        console.log('⚠️ No FCM tokens found for receptionists');
        return null;
      }

      // Create multicast notification
      const message = {
        notification: {
          title: 'Appointment Updated',
          body: `Patient ${patientName}`,
        },
        data: {
          appointmentId: context.params.appointmentId,
          doctorId: doctorId,
          type: 'updated_appointment',
        },
        tokens: tokens,
      };

      // Send multicast notification
      const response = await admin.messaging().sendMulticast(message);

      console.log(`✅ Notification sent to ${response.successCount} devices`);
      if (response.failureCount > 0) {
        console.log(`❌ Failed to send to ${response.failureCount} devices`);
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            console.log(`❌ Token ${idx} failed: ${resp.error}`);
          }
        });
      }

      return null;
    } catch (error) {
      console.error('❌ Error sending update notification:', error);
      return null;
    }
  });
