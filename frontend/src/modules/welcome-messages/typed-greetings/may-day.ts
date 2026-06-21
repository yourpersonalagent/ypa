import type { WelcomeDay } from './types';

const day: WelcomeDay = {
  id: 'may-day',
  label: 'May Day',
  messages: [
    "Midnight on May 1, {name}. Spring confirmed.",      // 00:00
    "01:00 on May Day, {name}.",                         // 01:00
    "Late, {name}. Workers' day technically started.",   // 02:00
    "Three a.m. on May 1, {name}.",                      // 03:00
    "Pre-dawn, {name}.",                                 // 04:00
    "Early on May Day, {name}.",                         // 05:00
    "Sunrise on May 1, {name}.",                         // 06:00
    "Morning of May Day, {name}.",                       // 07:00
    "Coffee, {name}. Holidays exist.",                   // 08:00
    "Mid-morning, {name}. Parades somewhere.",           // 09:00
    "Ten a.m. on May 1, {name}.",                        // 10:00
    "Almost noon, {name}.",                              // 11:00
    "Noon on May Day, {name}. Sun in agreement.",        // 12:00
    "Past noon, {name}.",                                // 13:00
    "Afternoon, {name}. Picnic weather.",                // 14:00
    "Three o'clock on May 1, {name}.",                   // 15:00
    "Late afternoon, {name}.",                           // 16:00
    "Evening of May Day, {name}.",                       // 17:00
    "Dinner outside, ideally, {name}.",                  // 18:00
    "Late dinner, {name}.",                              // 19:00
    "Eight p.m., {name}. Long evening.",                 // 20:00
    "Late evening on May 1, {name}.",                    // 21:00
    "Almost done with May Day, {name}.",                 // 22:00
    "Last hour of May 1, {name}.",                       // 23:00
  ],
};

export default day;
