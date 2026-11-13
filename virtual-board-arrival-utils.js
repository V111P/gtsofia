(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GTSofiaVirtualBoardArrivals = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function normalizeRoutes(routes) {
    return (Array.isArray(routes) ? routes : [])
      .map(route => {
        const isMetro = route?.meta?.type === 'metro';
        const times = (Array.isArray(route?.times) ? route.times : [])
          .filter(time => {
            const isRealtime = time?.source === 'realtime'
              || time?.realtime === true
              || time?.isRealtime === true;
            const isScheduled = time?.source === 'schedule'
              || time?.scheduled === true
              || time?.isScheduled === true;
            // Surface transport may contain both sources in the same direction.
            // Metro remains timetable-only.
            return isMetro ? isScheduled : (isRealtime || isScheduled);
          })
          .map(time => {
            const realtime = time?.source === 'realtime'
              || time?.realtime === true
              || time?.isRealtime === true;
            const scheduled = time?.source === 'schedule'
              || time?.scheduled === true
              || time?.isScheduled === true;
            return {
              ...time,
              realtime,
              scheduled: !realtime && scheduled,
              source: realtime ? 'realtime' : 'schedule'
            };
          })
          .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
          .slice(0, 3);
        return {
          ...route,
          realtime: times.some(time => time.realtime),
          scheduled: times.some(time => time.scheduled),
          times
        };
      })
      .filter(route => route.times.length > 0);
  }

  return { normalizeRoutes };
});
