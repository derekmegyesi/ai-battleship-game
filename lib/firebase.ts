/**
 * Firebase web client: import `db` for Firestore, `app` for Auth or other services.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

function publicEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      `Missing ${name}. Add it to .env.local (Firebase console → Project settings → Your apps).`,
    );
  }
  return v;
}

const firebaseConfig = {
  apiKey: publicEnv("NEXT_PUBLIC_FIREBASE_API_KEY"),
  authDomain: publicEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
  projectId: publicEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  storageBucket: publicEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: publicEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
  appId: publicEnv("NEXT_PUBLIC_FIREBASE_APP_ID"),
};

export const app: FirebaseApp = initializeApp(firebaseConfig);
export const db: Firestore = getFirestore(app);
