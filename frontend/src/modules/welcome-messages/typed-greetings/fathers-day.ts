import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'fathers-day',
  label: "Father's Day",
  messages: [
    "Midnight on Father's Day, {name}.",                 // 00:00
    "01:00 — he's asleep, {name}.",                      // 01:00
    "Late hour on Father's Day, {name}.",                // 02:00
    "Three a.m., {name}.",                               // 03:00
    "Pre-dawn, {name}.",                                 // 04:00
    "Early start, {name}.",                              // 05:00
    "Morning, {name}. Coffee for two?",                  // 06:00
    "Coffee, {name}.",                                   // 07:00
    "Morning of Father's Day, {name}. Did you call?",    // 08:00
    "BBQ smoke rising somewhere, {name}.",               // 09:00
    "Mid-morning, {name}. Tools in motion.",             // 10:00
    "Almost noon, {name}. Call him.",                    // 11:00
    "Noon on Father's Day, {name}.",                     // 12:00
    "Past noon, {name}. Burgers sizzling.",              // 13:00
    "Afternoon, {name}. The grill is winning.",          // 14:00
    "Three o'clock on Father's Day, {name}.",            // 15:00
    "Late afternoon, {name}.",                           // 16:00
    "Evening, {name}. Did you call yet?",                // 17:00
    "Dinner hour, {name}.",                              // 18:00
    "Stories at the table, {name}.",                     // 19:00
    "Eight p.m. on Father's Day, {name}.",               // 20:00
    "Late evening, {name}.",                             // 21:00
    "Almost done, {name}.",                              // 22:00
    "Last hour of Father's Day, {name}.",                // 23:00
  ],
};

export default day;
