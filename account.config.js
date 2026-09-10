'use strict';

// Keep e621 account credentials server-side only.
// Configure these through the hosting provider's environment variables.
module.exports = {
  username: process.env.E621_ACCOUNT_USERNAME || 'eweg',
  apiKey: process.env.E621_ACCOUNT_API_KEY || '58yCNJehFq2XaBJQvHnXBbKW'
};
