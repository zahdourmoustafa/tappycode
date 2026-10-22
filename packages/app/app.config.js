/**
 * Keeps one person's Expo account out of everyone's repo.
 *
 * `eas init` writes `owner` and `extra.eas.projectId` straight into `app.json`,
 * which pins the project to whoever ran it. In a project whose whole pitch is
 * "fork it and rebuild", that is the wrong default twice over: a fork inherits
 * an account it cannot push to, and the first `eas build` in that fork either
 * fails or silently retargets someone else's project.
 *
 * So `app.json` stays account-neutral and the identity is supplied per machine:
 *
 * 1. `EAS_OWNER` / `EAS_PROJECT_ID` in the environment — for CI.
 * 2. `eas-project.json` beside this file — for a laptop. Gitignored.
 *
 * With neither, the config is exactly what is committed, which is what a fresh
 * clone should see. `npx eas init` then fills it in for that person.
 */
const fs = require("node:fs");
const path = require("node:path");

const { expo } = require("./app.json");

/** Whose account this working copy builds under. Absent on a fresh clone. */
function localIdentity() {
  const file = path.join(__dirname, "eas-project.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    // Never fail a build over this: an unreadable file means "not configured",
    // and the message has to say which file, or it reads as an Expo bug.
    console.warn(`Ignoring ${file}: ${error.message}`);
    return {};
  }
}

module.exports = () => {
  const local = localIdentity();
  const owner = process.env.EAS_OWNER ?? local.owner;
  const projectId = process.env.EAS_PROJECT_ID ?? local.projectId;

  // Android notifications without any Expo account: the Firebase project's
  // client file, which identifies the project (it is not a secret, but it is
  // one person's project, so it is gitignored like the identity above). Only
  // named when present — naming a missing file fails the build.
  const googleServices = path.join(__dirname, "google-services.json");
  const android = fs.existsSync(googleServices)
    ? { ...expo.android, googleServicesFile: "./google-services.json" }
    : expo.android;

  return {
    ...expo,
    android,
    ...(owner ? { owner } : {}),
    ...(projectId
      ? { extra: { ...expo.extra, eas: { ...expo.extra?.eas, projectId } } }
      : {}),
  };
};
