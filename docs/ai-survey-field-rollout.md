# AI survey V1 field rollout

Use this after the automated release checks. Do not mark the device or 30-survey gates complete from browser emulation alone.

## Physical-device sign-off

Run the following on the estimator's actual iPad Safari, one iPhone Safari and one Android Chrome device. Use Peter's test lead first, then a real shadow survey only after the test passes.

| Check | iPad Safari | iPhone Safari | Android Chrome |
|---|---|---|---|
| Portrait layout: consent, room list, camera and controls remain usable | ☐ | ☐ | ☐ |
| Landscape layout: full camera frame is visible without cropping | ☐ | ☐ | ☐ |
| Rear camera opens at the widest supported zoom | ☐ | ☐ | ☐ |
| Camera denied: clear error appears and Import video remains available | ☐ | ☐ | ☐ |
| Microphone denied: clear error appears; retry works after permission change | ☐ | ☐ | ☐ |
| Narration off: recording completes without audio | ☐ | ☐ | ☐ |
| Stop recording: replay appears with Retake and Use clip | ☐ | ☐ | ☐ |
| Background/lock during recording: partial clip survives or a clear retry is shown | ☐ | ☐ | ☐ |
| Upload reaches 100%, then status changes Analysing → Ready | ☐ | ☐ | ☐ |
| Review items opens and the room can be confirmed | ☐ | ☐ | ☐ |

Record device model, OS/browser version, date, tester and any failure below. A failure blocks AI-first use on that device type but does not block the manual cubic survey.

## Thirty-survey shadow log

Connor and Luke continue their normal manual count while AI runs. Nothing customer-visible changes. Record one row per completed real survey.

| # | Date | Estimator | Lead/ref | Device | Capture uploaded? | AI raw ft³ | Manual ground-truth ft³ | Error % | Largest undercount % | Review seconds | Missing room/item or duplicate notes | Pass? |
|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---|---|
| 1 | | | | | | | | | | | | |
| 2 | | | | | | | | | | | | |
| 3 | | | | | | | | | | | | |
| 4 | | | | | | | | | | | | |
| 5 | | | | | | | | | | | | |
| 6 | | | | | | | | | | | | |
| 7 | | | | | | | | | | | | |
| 8 | | | | | | | | | | | | |
| 9 | | | | | | | | | | | | |
| 10 | | | | | | | | | | | | |
| 11 | | | | | | | | | | | | |
| 12 | | | | | | | | | | | | |
| 13 | | | | | | | | | | | | |
| 14 | | | | | | | | | | | | |
| 15 | | | | | | | | | | | | |
| 16 | | | | | | | | | | | | |
| 17 | | | | | | | | | | | | |
| 18 | | | | | | | | | | | | |
| 19 | | | | | | | | | | | | |
| 20 | | | | | | | | | | | | |
| 21 | | | | | | | | | | | | |
| 22 | | | | | | | | | | | | |
| 23 | | | | | | | | | | | | |
| 24 | | | | | | | | | | | | |
| 25 | | | | | | | | | | | | |
| 26 | | | | | | | | | | | | |
| 27 | | | | | | | | | | | | |
| 28 | | | | | | | | | | | | |
| 29 | | | | | | | | | | | | |
| 30 | | | | | | | | | | | | |

`Error % = abs(AI raw - manual ground truth) / manual ground truth × 100`.

## Release decision after survey 30

AI-first can become the default estimator workflow only when all PRD gates hold:

- At least 95% of valid capture sessions reach a reviewable result.
- Median raw-volume error is no more than 15%.
- No accepted-quality survey underestimates confirmed volume by more than 10%.
- Median estimator review time is no more than 60 seconds, excluding processing wait.
- Missing rooms, unusable footage and unresolved high-volume items continue to fail closed.

If a gate fails, leave the feature in shadow mode, record the failure pattern and correct it before collecting a fresh representative sample. The emergency rollback is Settings → AI surveyor → Enabled off; the manual survey and confirmed inventory remain available.
