/**
 * Firebase web client: import `db` for Firestore, `app` for Auth or other services.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: "ai-battleship-2026.firebaseapp.com",
  projectId: "ai-battleship-2026",
  storageBucket: "ai-battleship-2026.firebasestorage.app",
  messagingSenderId: "959108132025",
  appId: "1:959108132025:web:05b9000e9f4401afe23f68",
};

export const app: FirebaseApp = initializeApp(firebaseConfig);
export const db: Firestore = getFirestore(app);

