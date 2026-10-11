
"use strict";

const micButton = document.getElementById("micButton");
const finishButton = document.getElementById("finishButton");
const shareButton = document.getElementById("shareButton");
const clearButton = document.getElementById("clearButton");

const transcript = document.getElementById("transcript");
const statusText = document.getElementById("status");
const hint = document.getElementById("hint");
const wordCount = document.getElementById("wordCount");
const charCount = document.getElementById("charCount");
const pulse = document.getElementById("pulse");
const toast = document.getElementById("toast");

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let finalTranscript = "";
let interimTranscript = "";
let state = "idle"; // idle, listening, paused
let toastTimer = null;

// --------------------------------------------------
// Messages et affichage
// --------------------------------------------------

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 3200);
}

function updateStatus(message, description = "") {
  statusText.textContent = message;
  hint.textContent = description;
}

function updateCounters() {
  const text = transcript.value.trim();
  const words = text ? text.split(/\s+/u).length : 0;
  const characters = transcript.value.length;

  wordCount.textContent =
    `${words} ${words > 1 ? "mots" : "mot"}`;

  charCount.textContent =
    `${characters} ${characters > 1 ? "caractères" : "caractère"}`;
}

function renderTranscript() {
  transcript.value = finalTranscript + interimTranscript;
  updateCounters();

  // Maintient la visibilité du texte le plus récent.
  transcript.scrollTop = transcript.scrollHeight;
}

function updateInterface() {
  const listening = state === "listening";
  const paused = state === "paused";
  const active = listening || paused;

  micButton.classList.toggle("is-listening", listening);
  pulse.classList.toggle("active", listening);

  micButton.setAttribute("aria-pressed", String(listening));

  if (listening) {
    micButton.setAttribute("aria-label", "Mettre la dictée en pause");
    updateStatus("Je vous écoute…", "Appuyez pour mettre en pause");
  } else if (paused) {
    micButton.setAttribute("aria-label", "Reprendre la dictée");
    updateStatus("Dictée en pause", "Appuyez pour reprendre");
  } else {
    micButton.setAttribute("aria-label", "Démarrer la dictée");

    if (!SpeechRecognition) {
      updateStatus("Dictée indisponible", "Navigateur non compatible");
    } else {
      updateStatus("Prêt à vous écouter", "Appuyez sur le microphone pour commencer");
    }
  }

  finishButton.disabled = !active;
}

// --------------------------------------------------
// Mise en forme du texte reconnu
// --------------------------------------------------

function appendRecognizedText(current, segment) {
  let addition = segment.trim();

  if (!addition) {
    return current;
  }

  // Supprime les espaces inutiles avant la ponctuation.
  addition = addition.replace(/\s+([,.;:!?])/g, "$1");

  if (!current) {
    addition = capitalizeFirst(addition);
    return addition;
  }

  const needsSpace =
    !/[([{«“]$/u.test(current) &&
    !/^[,.;:!?%)\]}»”]/u.test(addition);

  let result = current + (needsSpace ? " " : "") + addition;

  // Corrige les espaces avant les signes de ponctuation.
  result = result.replace(/\s+([,.;:!?])/g, "$1");

  // Majuscule au début d'une phrase.
  result = result.replace(
    /(^|[.!?]\s+)([\p{Ll}àâäéèêëïîôöùûüÿç])/gu,
    (_, prefix, letter) => prefix + letter.toLocaleUpperCase("fr-FR")
  );

  return result;
}

function capitalizeFirst(text) {
  if (!text) return text;

  return text.charAt(0).toLocaleUpperCase("fr-FR") + text.slice(1);
}

// --------------------------------------------------
// Gestion de la reconnaissance vocale
// --------------------------------------------------

function startListening() {
  if (!SpeechRecognition) {
    showToast(
      "La reconnaissance vocale n'est pas disponible dans ce navigateur. Essayez Safari sur iPhone ou Chrome sur ordinateur."
    );
    return;
  }

  if (!window.isSecureContext) {
    showToast(
      "Le microphone nécessite une connexion sécurisée HTTPS ou une adresse localhost."
    );
    return;
  }

  try {
    const currentRecognition = new SpeechRecognition();
    recognition = currentRecognition;

    currentRecognition.lang = "fr-FR";
    currentRecognition.continuous = true;
    currentRecognition.interimResults = true;
    currentRecognition.maxAlternatives = 1;

    state = "listening";
    interimTranscript = "";
    updateInterface();

    currentRecognition.onresult = (event) => {
      // Ignore les événements d'une ancienne session.
      if (recognition !== currentRecognition) return;

      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const spokenText = result[0].transcript;

        if (result.isFinal) {
          finalTranscript = appendRecognizedText(
            finalTranscript,
            spokenText
          );
        } else {
          interim += spokenText;
        }
      }

      interimTranscript = interim;
      renderTranscript();
    };

    currentRecognition.onerror = (event) => {
      if (recognition !== currentRecognition) return;

      const messages = {
        "not-allowed": "Autorisez l'accès au microphone et à la reconnaissance vocale.",
        "service-not-allowed": "Le service de reconnaissance vocale est bloqué.",
        "audio-capture": "Aucun microphone accessible n'a été détecté.",
        "network": "Erreur réseau pendant la reconnaissance vocale.",
        "no-speech": "Aucune parole détectée. Vous pouvez continuer.",
        "language-not-supported": "La reconnaissance du français n'est pas disponible."
      };

      const message =
        messages[event.error] ||
        `Erreur de reconnaissance : ${event.error}`;

      showToast(message);

      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "audio-capture" ||
        event.error === "language-not-supported"
      ) {
        state = "idle";
        interimTranscript = "";
        updateInterface();
      }
    };

    currentRecognition.onend = () => {
      if (recognition !== currentRecognition) return;

      // Si le navigateur termine une session spontanément,
      // on tente de reprendre tant que l'utilisateur écoute.
      if (state === "listening") {
        recognition = null;
        startListening();
        return;
      }

      recognition = null;
      interimTranscript = "";
      renderTranscript();
      updateInterface();
    };

    currentRecognition.start();
  } catch (error) {
    state = "idle";
    recognition = null;
    interimTranscript = "";
    updateInterface();

    console.error("Impossible de démarrer la dictée :", error);
    showToast("Impossible de démarrer la dictée. Réessayez.");
  }
}

function pauseListening() {
  if (state !== "listening") return;

  // Change l'état avant stop() afin d'empêcher
  // une reprise automatique dans onend.
  state = "paused";
  interimTranscript = "";

  const currentRecognition = recognition;
  recognition = null;

  if (currentRecognition) {
    try {
      currentRecognition.stop();
    } catch (error) {
      console.warn("Arrêt de la reconnaissance :", error);
    }
  }

  renderTranscript();
  updateInterface();
}

function finishListening() {
  const currentRecognition = recognition;

  state = "idle";
  interimTranscript = "";
  recognition = null;

  if (currentRecognition) {
    try {
      currentRecognition.stop();
    } catch (error) {
      console.warn("Fin de la reconnaissance :", error);
    }
  }

  renderTranscript();
  updateInterface();
  showToast("Dictée terminée.");
}

// --------------------------------------------------
// Commande principale : démarrer / pause / reprise
// --------------------------------------------------

micButton.addEventListener("click", () => {
  if (state === "listening") {
    pauseListening();
  } else {
    // Depuis l'état en pause, le texte déjà dicté
    // est conservé avant de reprendre.
    finalTranscript = transcript.value;
    interimTranscript = "";
    startListening();
  }
});

finishButton.addEventListener("click", finishListening);

// --------------------------------------------------
// Édition manuelle
// --------------------------------------------------

transcript.addEventListener("input", () => {
  // Le texte saisi manuellement devient la nouvelle
  // base de la prochaine session de reconnaissance.
  finalTranscript = transcript.value;
  interimTranscript = "";
  updateCounters();
});

clearButton.addEventListener("click", () => {
  finalTranscript = "";
  interimTranscript = "";
  transcript.value = "";
  updateCounters();

  showToast("Texte effacé.");
});

// --------------------------------------------------
// Partage natif iOS / navigateur
// --------------------------------------------------

shareButton.addEventListener("click", async () => {
  const text = transcript.value.trim();

  if (!text) {
    showToast("Dictez ou saisissez un texte avant de le partager.");
    return;
  }

  const shareData = {
    title: "Texte dicté avec Dicto",
    text
  };

  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
      await navigator.share(shareData);
      return;
    }

    // Repli pour les navigateurs sans feuille de partage.
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      showToast("Texte copié. Vous pouvez le coller dans votre e-mail.");
      return;
    }

    // Dernier recours : sélection du texte.
    transcript.focus();
    transcript.select();
    showToast("Texte sélectionné. Copiez-le pour le partager.");
  } catch (error) {
    if (error.name === "AbortError") {
      // L'utilisateur a fermé la feuille de partage.
      return;
    }

    console.error("Erreur de partage :", error);
    showToast("Le partage a échoué. Vous pouvez copier le texte manuellement.");
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .catch((error) => {
        console.error(
          "Impossible d'enregistrer le service worker :",
          error
        );
      });
  });
}

// --------------------------------------------------
// Initialisation
// --------------------------------------------------

updateCounters();
updateInterface();
