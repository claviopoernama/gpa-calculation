import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const REQUIRED_KEYS = ["apiKey", "authDomain", "projectId", "appId"];

function resolveConfig() {
  const config = window.__FIREBASE_CONFIG__;

  if (!config) {
    throw new Error(
      "Firebase config is missing. Define window.__FIREBASE_CONFIG__ with your Firebase project's web app credentials before loading firebase-config.js."
    );
  }

  const missing = REQUIRED_KEYS.filter((key) => {
    const value = config[key];
    return !value || (typeof value === "string" && value.startsWith("YOUR_"));
  });

  if (missing.length > 0) {
    console.warn(
      "[firebase-config] The following Firebase config values look like placeholders and should be replaced with real credentials from the Firebase console: " +
        missing.join(", ")
    );
  }

  return config;
}

const firebaseConfig = resolveConfig();

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;