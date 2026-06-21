import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'default',
  label: 'Default',
  messages: [
    "Late hour, {name}.",                                  // 00:00
    "01:00 — the brain has ideas now, {name}.",            // 01:00
    "Still up, {name}?",                                   // 02:00
    "Three a.m., {name}. The good thoughts arrive.",       // 03:00
    "Pre-dawn, {name}.",                                   // 04:00
    "Up before the birds, {name}?",                        // 05:00
    "Early one, {name}.",                                  // 06:00
    "Good morning, {name}.",                               // 07:00
    "A lot planned today, {name}?",                        // 08:00
    "Morning steam, {name}.",                              // 09:00
    "Mid-morning, {name}. The day still believes in you.", // 10:00
    "Almost noon, {name}.",                                // 11:00
    "Noon, {name}.",                                       // 12:00
    "Past noon, {name}.",                                  // 13:00
    "Afternoon dip, {name}.",                              // 14:00
    "Three o'clock, {name}.",                              // 15:00
    "Late afternoon, {name}.",                             // 16:00
    "End of the day, {name}?",                             // 17:00
    "Evening, {name}.",                                    // 18:00
    "Dinner hour, {name}.",                                // 19:00
    "Long evening, {name}.",                               // 20:00
    "Late evening, {name}.",                               // 21:00
    "Wrapping up, {name}?",                                // 22:00
    "Almost midnight, {name}.",                            // 23:00
  ],
};

export default day;
