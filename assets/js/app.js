import { initializeI18n } from "./i18n.js";

function setCurrentYear() {
  const yearElement = document.getElementById("current-year");
  if (!yearElement) {
    return;
  }

  yearElement.textContent = String(new Date().getFullYear());
}

async function bootstrap() {
  setCurrentYear();
  await initializeI18n();
}

void bootstrap();
