import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'new-years-eve',
  label: "New Year's Eve",
  messages: [
    "Midnight on Dec 31, {name}. The last day starts.",  // 00:00
    "01:00 on the year's last day, {name}.",             // 01:00
    "Late, {name}. 22 hours till the year ends.",        // 02:00
    "Three a.m. on NYE, {name}.",                        // 03:00
    "Pre-dawn of the last day, {name}.",                 // 04:00
    "Early on Dec 31, {name}.",                          // 05:00
    "Morning of NYE, {name}.",                           // 06:00
    "Coffee on the last day, {name}.",                   // 07:00
    "Eight a.m. on Dec 31, {name}.",                     // 08:00
    "Mid-morning, year winding down, {name}.",           // 09:00
    "Ten a.m. on NYE, {name}. 14 hours left.",           // 10:00
    "Almost noon on the last day, {name}.",              // 11:00
    "Noon on Dec 31, {name}. Halfway.",                  // 12:00
    "Past noon, {name}. The year is fading.",            // 13:00
    "Afternoon of NYE, {name}.",                         // 14:00
    "Three o'clock on Dec 31, {name}.",                  // 15:00
    "Late afternoon, the year is done, {name}.",         // 16:00
    "Five p.m., {name}. Plans loading.",                 // 17:00
    "Evening of NYE, {name}.",                           // 18:00
    "Dinner before midnight, {name}.",                   // 19:00
    "Four hours till next year, {name}.",                // 20:00
    "Three hours to go, {name}.",                        // 21:00
    "Late evening, getting close, {name}.",              // 22:00
    "Last hour of the year, {name}. Champagne ready?",   // 23:00
  ],
};

export default day;
