import { auth, db } from "../firebase.js";
import {
  onAuthStateChanged,
  updateEmail
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  doc,
  getDoc,
  updateDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Form elements
const fullNameInput = document.getElementById("fullName");
const emailInput = document.getElementById("email");
const phoneInput = document.getElementById("phone");
const addressInput = document.getElementById("address");
const photoInput = document.getElementById("photo");
const form = document.getElementById("profileForm");
const message = document.getElementById("message");

let currentUser;

// Load user data
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "Login.html";
    return;
  }

  currentUser = user;
  emailInput.value = user.email;

  const userDocRef = doc(db, "users", user.uid);

  // Real-time listener for Firestore data
  onSnapshot(userDocRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      fullNameInput.value = data.fullName || "";
      phoneInput.value = data.phone || "";
      addressInput.value = data.address || "";

      // Show profile photo preview in edit form
      let imgPreview = document.getElementById("photoPreview");
      if (!imgPreview) {
        imgPreview = document.createElement("img");
        imgPreview.id = "photoPreview";
        imgPreview.style.width = "80px";
        imgPreview.style.height = "80px";
        imgPreview.style.borderRadius = "50%";
        imgPreview.style.marginBottom = "12px";
        form.insertBefore(imgPreview, form.firstChild);
      }
      imgPreview.src = data.photoURL || "default-avatar.png";
    }
  });
});

// Save changes
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  message.textContent = "";

  try {
    // Update Firestore fields
    await updateDoc(doc(db, "users", currentUser.uid), {
      fullName: fullNameInput.value,
      phone: phoneInput.value,
      address: addressInput.value
    });

    // Update email if changed
    if (emailInput.value !== currentUser.email) {
      await updateEmail(currentUser, emailInput.value);
    }

    // Upload profile photo if selected
    if (photoInput.files.length > 0) {
      const file = photoInput.files[0];
      const storage = getStorage();
      const storageRef = ref(storage, `profilePhotos/${currentUser.uid}`);
      await uploadBytes(storageRef, file);
      const photoURL = await getDownloadURL(storageRef);

      // Save photoURL in Firestore
      await updateDoc(doc(db, "users", currentUser.uid), { photoURL });
    }

    message.style.color = "green";
    message.textContent = "Profile updated successfully!";
  } catch (error) {
    message.style.color = "red";
    message.textContent = error.message;
    console.error(error);
  }
});
