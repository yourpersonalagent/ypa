import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'mothers-day',
  label: "Mother's Day",
  messages: [
    "Midnight on Mother's Day, {name}.",                 // 00:00
    "01:00 — she's not awake, {name}.",                  // 01:00
    "Late hour, Mother's Day, {name}.",                  // 02:00
    "Three a.m., {name}.",                               // 03:00
    "Pre-dawn, {name}.",                                 // 04:00
    "Early start, {name}.",                              // 05:00
    "Morning, {name}. Brunch ideas?",                    // 06:00
    "Coffee, {name}. She probably has hers already.",    // 07:00
    "Morning of Mother's Day, {name}. Did you call?",    // 08:00
    "Florists are sprinting, {name}.",                   // 09:00
    "Mid-morning, {name}. Brunch crowds rising.",        // 10:00
    "Almost noon, {name}. Last call to call.",           // 11:00
    "Noon on Mother's Day, {name}.",                     // 12:00
    "Past noon, {name}. Brunch happened.",               // 13:00
    "Afternoon, {name}. Maybe a walk together.",         // 14:00
    "Three o'clock, {name}.",                            // 15:00
    "Late afternoon, {name}. Cake somewhere.",           // 16:00
    "Evening, {name}. Did you call yet?",                // 17:00
    "Dinner hour, {name}.",                              // 18:00
    "Family table is set somewhere, {name}.",            // 19:00
    "Eight p.m. on Mother's Day, {name}.",               // 20:00
    "Late evening, {name}. One more call.",              // 21:00
    "Almost done with the day, {name}.",                 // 22:00
    "Last hour of Mother's Day, {name}.",                // 23:00
  ],
};

export default day;
