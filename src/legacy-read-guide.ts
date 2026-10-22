/** Current catalogues stay small; cached clients can still call their saved reads. */
export const LEGACY_READ_INSTRUCTIONS =
  "Compatibility names remain callable but are not advertised: get_recent_messages/get_unanswered map to catch_up, " +
  "search_messages to search, search_contacts to find_contact, download_media/transcribe_audio to get_media. " +
  "Use only names in your client's catalogue; get_status lists accounts.";
