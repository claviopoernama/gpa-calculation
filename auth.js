import { auth } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";

const PAGE = {
  AUTH: "index.html",
  DASHBOARD: "dashboard.html",
};

function currentPageIsDashboard() {
  return window.location.pathname.endsWith(PAGE.DASHBOARD);
}

function currentPageIsAuth() {
  const path = window.location.pathname;
  return path.endsWith(PAGE.AUTH) || path.endsWith("/") || path === "";
}

function mapAuthError(error) {
  const code = error && error.code ? error.code : "";
  switch (code) {
    case "auth/email-already-in-use":
      return "That email is already registered. Try signing in instead.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/missing-email":
      return "Enter your email address.";
    case "auth/weak-password":
      return "Password must be at least 6 characters long.";
    case "auth/missing-password":
      return "Enter a password.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/operation-not-allowed":
      return "Email/password sign-in is not enabled for this project.";
    default:
      return error && error.message ? error.message : "Something went wrong. Please try again.";
  }
}

function showAuthError(message) {
  const errorBox = document.getElementById("auth-error");
  if (!errorBox) return;
  if (!message) {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
    return;
  }
  const successBox = document.getElementById("auth-success");
  if (successBox) {
    successBox.textContent = "";
    successBox.classList.add("hidden");
  }
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function showAuthSuccess(message) {
  const successBox = document.getElementById("auth-success");
  if (!successBox) return;
  if (!message) {
    successBox.textContent = "";
    successBox.classList.add("hidden");
    return;
  }
  const errorBox = document.getElementById("auth-error");
  if (errorBox) {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }
  successBox.textContent = message;
  successBox.classList.remove("hidden");
}

function setButtonLoading(button, isLoading, loadingText) {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText || "Please wait…";
    button.disabled = true;
    button.classList.add("opacity-70", "cursor-not-allowed");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove("opacity-70", "cursor-not-allowed");
  }
}

function initTabs() {
  const tabSignIn = document.getElementById("tab-signin");
  const tabSignUp = document.getElementById("tab-signup");
  const panelSignIn = document.getElementById("panel-signin");
  const panelSignUp = document.getElementById("panel-signup");

  if (!tabSignIn || !tabSignUp || !panelSignIn || !panelSignUp) return;

  function activate(tab) {
    const isSignIn = tab === "signin";

    tabSignIn.classList.toggle("auth-tab-active", isSignIn);
    tabSignIn.setAttribute("aria-selected", String(isSignIn));
    tabSignUp.classList.toggle("auth-tab-active", !isSignIn);
    tabSignUp.setAttribute("aria-selected", String(!isSignIn));

    panelSignIn.classList.toggle("hidden", !isSignIn);
    panelSignUp.classList.toggle("hidden", isSignIn);

    showAuthError("");
    showAuthSuccess("");
  }

  tabSignIn.addEventListener("click", () => activate("signin"));
  tabSignUp.addEventListener("click", () => activate("signup"));
}

function initSignInForm() {
  const form = document.getElementById("signin-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showAuthError("");
    showAuthSuccess("");

    const email = form.querySelector("#signin-email").value.trim();
    const password = form.querySelector("#signin-password").value;
    const submitBtn = form.querySelector("button[type='submit']");

    if (!email || !password) {
      showAuthError("Enter both email and password.");
      return;
    }

    setButtonLoading(submitBtn, true, "Signing in…");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      showAuthError(mapAuthError(error));
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}

function initSignUpForm() {
  const form = document.getElementById("signup-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showAuthError("");
    showAuthSuccess("");

    const name = form.querySelector("#signup-name").value.trim();
    const email = form.querySelector("#signup-email").value.trim();
    const password = form.querySelector("#signup-password").value;
    const confirmPassword = form.querySelector("#signup-confirm-password").value;
    const submitBtn = form.querySelector("button[type='submit']");

    if (!name) {
      showAuthError("Enter your full name.");
      return;
    }
    if (!email) {
      showAuthError("Enter an email address.");
      return;
    }
    if (password.length < 6) {
      showAuthError("Password must be at least 6 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      showAuthError("Passwords do not match.");
      return;
    }

    setButtonLoading(submitBtn, true, "Creating account…");
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: name });
    } catch (error) {
      showAuthError(mapAuthError(error));
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}

function initLogoutButton() {
  const logoutBtn = document.getElementById("logout-btn");
  if (!logoutBtn) return;

  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Sign out failed:", error);
      logoutBtn.disabled = false;
    }
  });
}

function initForgotPassword() {
  const tabList = document.querySelector('[role="tablist"]');
  const panelSignIn = document.getElementById("panel-signin");
  const panelSignUp = document.getElementById("panel-signup");
  const panelForgot = document.getElementById("panel-forgot");
  const forgotLink = document.getElementById("forgot-password-link");
  const backLink = document.getElementById("back-to-signin-link");
  const forgotForm = document.getElementById("forgot-password-form");

  if (!panelForgot || !forgotLink || !backLink || !forgotForm || !panelSignIn || !panelSignUp) return;

  function showForgotPanel() {
    showAuthError("");
    showAuthSuccess("");
    if (tabList) tabList.classList.add("hidden");
    panelSignIn.classList.add("hidden");
    panelSignUp.classList.add("hidden");
    panelForgot.classList.remove("hidden");
    const emailInput = document.getElementById("forgot-email");
    if (emailInput) emailInput.focus();
  }

  function showSignInPanel() {
    showAuthError("");
    showAuthSuccess("");
    forgotForm.reset();
    panelForgot.classList.add("hidden");
    panelSignUp.classList.add("hidden");
    panelSignIn.classList.remove("hidden");
    if (tabList) tabList.classList.remove("hidden");

    const tabSignIn = document.getElementById("tab-signin");
    const tabSignUp = document.getElementById("tab-signup");
    if (tabSignIn && tabSignUp) {
      tabSignIn.classList.add("auth-tab-active");
      tabSignIn.setAttribute("aria-selected", "true");
      tabSignUp.classList.remove("auth-tab-active");
      tabSignUp.setAttribute("aria-selected", "false");
    }
  }

  forgotLink.addEventListener("click", showForgotPanel);
  backLink.addEventListener("click", showSignInPanel);

  forgotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    showAuthError("");
    showAuthSuccess("");

    const emailInput = document.getElementById("forgot-email");
    const email = emailInput.value.trim();
    const submitBtn = forgotForm.querySelector("button[type='submit']");

    if (!email) {
      showAuthError("Enter your email address.");
      emailInput.focus();
      return;
    }

    setButtonLoading(submitBtn, true, "Sending…");
    try {
      await sendPasswordResetEmail(auth, email);
      showAuthSuccess("Password reset link sent to your email!");
      forgotForm.reset();
    } catch (error) {
      showAuthError(mapAuthError(error));
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}

function initAuthRouting() {
  onAuthStateChanged(auth, (user) => {
    if (user && currentPageIsAuth()) {
      window.location.href = PAGE.DASHBOARD;
      return;
    }
    if (!user && currentPageIsDashboard()) {
      window.location.href = PAGE.AUTH;
      return;
    }

    document.body.setAttribute("data-auth-ready", "true");
    const overlay = document.getElementById("route-loading-overlay");
    if (overlay) overlay.classList.add("hidden");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initSignInForm();
  initSignUpForm();
  initLogoutButton();
  initForgotPassword();
  initAuthRouting();
});

export { mapAuthError };