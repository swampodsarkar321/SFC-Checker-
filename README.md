# SFC TICKET CHECKER website

This repository publishes the static download website through GitHub Pages. The website source is in `website/`; the root `index.html` forwards visitors to it. The current extension download is kept in `website/downloads/`.

## GitHub Pages

In the repository settings, open **Pages** and select **Deploy from a branch**, branch `main`, folder `/ (root)`. The website will be available at `https://swampodsarkar321.github.io/SFC-Checker-/` after Pages finishes deploying.

## Firebase download counter

The website counts download-button clicks in Firebase Realtime Database. Enable **Authentication → Sign-in method → Anonymous** in the Firebase project and publish these Realtime Database rules:

```json
{
  "rules": {
    "websiteDownloadEvents": {
      ".read": "auth != null",
      "$uid": {
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The counter records button clicks, not verified completed downloads. The Firebase web API key is public website configuration; database access must be protected by the rules above.
