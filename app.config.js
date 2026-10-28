// Layers the build profile (eas.json → RELEASE_CHANNEL, APP_VARIANT) over app.json.
// `npm run build:*` and the server-side builder set these, so every profile
// produces an APK that polls its own channel; a plain `expo start` keeps the
// production defaults of app.json.
module.exports = ({ config }) => {
  const channel = process.env.RELEASE_CHANNEL || config.updates.requestHeaders['expo-channel-name'];
  // A variant installs next to the production app: its own package id and name.
  const variant = process.env.APP_VARIANT;

  return {
    ...config,
    name: variant ? `${config.name} (${variant})` : config.name,
    android: {
      ...config.android,
      package: variant ? `${config.android.package}.${variant}` : config.android.package,
    },
    updates: {
      ...config.updates,
      requestHeaders: {
        ...config.updates.requestHeaders,
        'expo-channel-name': channel,
      },
    },
  };
};
