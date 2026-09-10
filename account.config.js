'use strict';

// Keep e621 account credentials server-side only.
// Configure these through the hosting provider's environment variables.
module.exports = {
  username: String(process.env.E621_ACCOUNT_USERNAME || '').trim(),
  apiKey: String(process.env.E621_ACCOUNT_API_KEY || '').trim()
};
