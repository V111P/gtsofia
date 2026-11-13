import { readFile } from 'node:fs/promises';

const SCHEDULE_DATA_URL = new URL('../data/virtual-board-schedules.json', import.meta.url);
let schedulePromise = null;

export async function getScheduleData() {
  if (!schedulePromise) {
    schedulePromise = readFile(SCHEDULE_DATA_URL, 'utf8')
      .then(JSON.parse)
      .then(data => {
        if (data?.schemaVersion !== 1 || !data?.calendar?.serviceBits || !data?.routes) {
          throw new Error('The generated virtual-board schedule index has an unsupported schema.');
        }
        return data;
      })
      .catch(error => {
        schedulePromise = null;
        throw new Error(`Unable to load the static virtual-board schedule index: ${error.message}`);
      });
  }
  return schedulePromise;
}
