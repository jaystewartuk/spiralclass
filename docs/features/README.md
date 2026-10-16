# Features

One file per feature, describing what the product does today. **This folder
owns product behaviour**: anything else that needs a business rule links here
instead of restating it. Reasoning lives in
[decision records](../decisions/README.md).

## Teachers and students

| File                                           | What it covers                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [user-roles.md](user-roles.md)                 | Teacher, student and staff roles, why one identity cannot be both teacher and student, and route gating    |
| [authentication.md](authentication.md)         | Passwordless sign-in (email code, Google), linking a student's roster row, and staff two-factor            |
| [account-settings.md](account-settings.md)     | A teacher's and a student's own account page: profile, sign-in email, notifications, export, deletion      |
| [teacher-management.md](teacher-management.md) | Onboarding, public listing (Marketplace Ready), intro video, working hours, blocked dates, Google Calendar |
| [student-management.md](student-management.md) | The roster: adding and inviting students, private notes, contact details, archiving, merging duplicates    |

## Money

| File                                             | What it covers                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [packages.md](packages.md)                       | Package templates, a package's balance and status, which package a booking draws from             |
| [payments.md](payments.md)                       | A student paying her teacher by card or Wise: checkout, refunds, disputes, earnings screens       |
| [subscriptions.md](subscriptions.md)             | Teachers paying SpiralClass: Free and Pro plans, entitlements, founding cohort, ambassador report |
| [referrals-discounts.md](referrals-discounts.md) | Teacher discount codes and the student referral program                                           |

## Classes

| File                                                     | What it covers                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [scheduling-booking.md](scheduling-booking.md)           | Slots, booking, the 24-hour cancellation rule, rescheduling, completion and no-shows       |
| [live-calls-video.md](live-calls-video.md)               | The in-class video call on self-hosted LiveKit, recording and live captions                |
| [classes-lesson-content.md](classes-lesson-content.md)   | Per-class content, lesson notes and the AI lesson summary                                  |
| [library-materials.md](library-materials.md)             | The teacher's reusable library of materials, levels and focus tags                         |
| [homework.md](homework.md)                               | Assignments on a class, student submissions and teacher feedback                           |
| [lesson-insights-reports.md](lesson-insights-reports.md) | Lesson transcripts from captions, insights and student progress reports, and their consent |

## Growth and communication

| File                                             | What it covers                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [student-acquisition.md](student-acquisition.md) | Get students: the weekly plan, communities and promotion policy, attribution, results, testimonials |
| [messaging-chat.md](messaging-chat.md)           | One-to-one teacher–student messages with voice, video, images and files                             |
| [notifications.md](notifications.md)             | The notification pipeline: push-first delivery, email, the in-app inbox and preferences             |
| [search.md](search.md)                           | The header search box in the teacher app and the student portal                                     |

## Operators

| File                               | What it covers                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| [admin-portal.md](admin-portal.md) | The staff console at `/admin`: support, money, disputes, costs, operations, test accounts |
