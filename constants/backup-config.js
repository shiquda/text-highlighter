// The automatic backup cadence and its bounded retry schedule.
//
// One alarm is the daily check; a failure that is worth retrying gets a
// one-shot alarm of its own rather than a shorter period on the daily one, so
// a day of failed attempts cannot pile up behind a single repeating timer.
export const BACKUP_ALARM_NAME = 'backupDailyAlarm';
export const BACKUP_ALARM_PERIOD_MINUTES = 24 * 60;

export const BACKUP_RETRY_ALARM_NAME = 'backupRetryAlarm';

// Doubling from a minute, capped at six hours: enough to ride out a drop-out or
// a rate limit, short enough that a temporary outage is not a lost day.
export const BACKUP_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 6 * 60 * 60 * 1000];
export const MAX_BACKUP_RETRIES = BACKUP_RETRY_DELAYS_MS.length;

// Codes worth trying again without the user doing anything: the request did not
// reach a decision. Everything else (a bad token, a wrong URL, a conflict, a
// decryption failure) needs the user, and retrying it just repeats the failure.
export const RETRYABLE_BACKUP_CODES = Object.freeze([
  'backup_network',
  'backup_timeout',
  'backup_rate_limited',
  'backup_server_error',
]);
