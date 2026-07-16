// Firebase client config. For LOCAL emulator play the values below are dummies —
// only projectId must match .firebaserc. To deploy for real, paste the web config
// from the Firebase console (Project settings → Your apps) over these values.
export const firebaseConfig = {
  apiKey: "AIzaSyAzki9Bpvzt67xzKdjiflpmJG3eJHPmwr8",
  authDomain: "grave-consequences.firebaseapp.com",
  projectId: "grave-consequences",
  storageBucket: "grave-consequences.firebasestorage.app",
  messagingSenderId: "103110067878",
  appId: "1:103110067878:web:0ce465f65981c0ab089667",
  measurementId: "G-MJSFWMFHTL"
};
// Auto-detect the emulator: anything served from localhost talks to the local suite.
export const USE_EMULATOR =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

export const FUNCTIONS_REGION = "us-central1";
