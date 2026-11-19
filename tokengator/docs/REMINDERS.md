# Reminders

Quota expires when nobody is looking at the dashboard. Reminders are how Tokengator reaches you then.

## The rule

A quota earns **one reminder per window**, at the moment it becomes **Use now**: it resets soon and at
least 10% of it is still there. "Soon" is the last 15% of the window, never less than 2 hours and
never more than 72: about a day before a weekly limit resets, three days before a monthly one.

- Windows shorter than two days (session limits, daily limits) are never raised. They would ring
  several times a day. The dashboard and the status line cover them.
- Several quotas due at the same time arrive as one message.
- Snoozed subscriptions stay quiet.
- A quota that cannot be used before it resets, because a session limit is closed until then, is
  not raised.
- An old reading still earns a reminder, worded as a prompt to check the real number.
- There are no repeats, no escalation and no quiet hours. Your system's Do Not Disturb and your
  phone's already decide when a notification may interrupt you.

A reminder reads like this:

```
Use Claude Max now
38% left of the weekly limit, resets in 14h (tomorrow 09:00). About $7.39 expires at this pace.
```

## Where it can reach you

Open **Menu > Reminders** in the dashboard to see all of them in one place.

| Route | Works when | Switch it on |
| --- | --- | --- |
| Browser tab | a Tokengator tab is open | Reminders panel |
| This computer | the service is running, browser open or not | Reminders panel, or `desktopReminders` in settings |
| Phone or chat | the service is running and online | `TOKENGATOR_NOTIFY_URL` |
| Calendar | always, also with the computer off | subscribe or import once |
| Agent status line | an agent session is open | `tokengator statusline` (see the README) |

### This computer

The service runs your system's own notification command. Nothing is installed and nothing leaves
the machine.

| System | Command | Notes |
| --- | --- | --- |
| Linux, BSD | `notify-send` | From `libnotify` (`libnotify-bin` on Debian and Ubuntu). Needs a desktop session; on a headless machine use the phone route instead. |
| macOS | `osascript` | Shown as coming from the script host. Focus modes apply. |
| Windows | Windows PowerShell 5.1 | Shown as coming from Windows PowerShell, whose identity the toast borrows. Do Not Disturb applies. |

Switching it on sends a test notification straight away and tells you if it could not be shown.

The automated tests check the command that is built for each system and that reminder text can
never become part of it. The notification itself has been exercised on Linux only; if a toast does
not appear on Windows or macOS, `tokengator notify --test` prints the reason.

### Phone or chat

Set one address and every reminder is also posted there:

```bash
# ~/.tokengator/.env
TOKENGATOR_NOTIFY_URL=https://ntfy.sh/a-long-name-only-you-know
```

- **ntfy**: install the ntfy app, subscribe to the same topic. On the public ntfy.sh server a topic
  name is the only secret, so make it long and random, or use your own server.
- **Slack** and **Discord**: paste an incoming-webhook address. Tokengator recognises them and
  sends the shape each expects.
- Anything else that accepts a line of text by POST works too (the title is in a `Title` header).

The address is treated like a password: it must be `https://` (plain `http://` is accepted for this
computer only), it is read from the environment when a reminder is sent, and it is never stored in
the state file, logged, or shown by the dashboard, the API or the CLI. Only its host name is.

What is sent is the two lines above and nothing else: no email address, no account id, no token,
no link back to your machine.

### Calendar

```bash
tokengator calendar --output resets.ics   # import the file into any calendar
```

(`--output` writes the file itself. In Windows PowerShell, `> resets.ics` would re-encode it.)

or subscribe to `http://127.0.0.1:4777/api/calendar.ics` in a calendar program **on the same
computer** (Apple Calendar, Thunderbird, Outlook for desktop). Web calendars fetch from their own
servers and cannot reach an address on your machine, so import the file there instead.

Each reset becomes an entry that covers the last stretch before it, the same stretch the dashboard
calls "Use now", with an alert when it begins. Entries say what resets, not how much is left: a
calendar copy is always older than the dashboard. Recurring windows are listed about two months
ahead. A window that only opens on first use (a Codex week, for example) is listed once.

When an access token is set, calendar programs cannot send it. Open the file from the dashboard,
where you are signed in, and import it.

## Without the service running

`tokengator notify` does one check and exits. Let your scheduler run it.

A scheduler does not search your PATH: it looks in two or three system directories, where neither
`tokengator` nor, usually, `node` is. So write the command out in full. `tokengator doctor` prints
it for your machine, under Reminders, in this form:

```
"/usr/local/bin/node" "/home/you/tokengator/dist/cli/main.js" notify
```

Below, `NODE` and `MAIN` stand for those two paths.

```bash
# cron, every 15 minutes (the session variable is what notify-send needs)
*/15 * * * * XDG_RUNTIME_DIR=/run/user/$(id -u) NODE MAIN notify
```

```powershell
# Windows Task Scheduler, every 15 minutes, for the signed-in user
$action  = New-ScheduledTaskAction -Execute 'NODE' -Argument '"MAIN" notify'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Tokengator reminders' -Action $action -Trigger $trigger
```

On Windows a console window appears for a moment at each run. Keeping the service running, as
below, avoids that and is the better choice there.

`tokengator notify --dry-run` prints what is due without sending or recording anything.
`tokengator notify --test` sends a test message through every route that is set up and, when one
fails, prints the reason the system gave.

## Starting the service at sign-in

Desktop reminders need the service. These are the standard per-user ways to keep it running; none
needs administrator rights, and none should be a system service, because a system service has no
desktop to show a notification on. `NODE` and `MAIN` are the two paths from `tokengator doctor`,
as above.

**Linux** (`~/.config/systemd/user/tokengator.service`, then `systemctl --user enable --now tokengator`):

```ini
[Unit]
Description=Tokengator

[Service]
ExecStart=NODE MAIN serve
Restart=on-failure

[Install]
WantedBy=default.target
```

**macOS** (`~/Library/LaunchAgents/dev.tokengator.plist`, then `launchctl load ~/Library/LaunchAgents/dev.tokengator.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.tokengator</string>
  <key>ProgramArguments</key>
  <array><string>NODE</string><string>MAIN</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
```

**Windows**: press Win+R, open `shell:startup`, and create a shortcut there whose target is
`"NODE" "MAIN" serve`, set to run minimised.

The scheduler and start-up recipes on this page were written from each system's documentation and
have not been run on a real machine. The command they start is the one `tokengator doctor` prints,
and that command is tested.

## What is kept

`~/.tokengator/reminders.json` holds the keys of reminders already raised (a meter id and a reset
time each), so a restart does not repeat them. Keys are dropped when their window ends. Deleting
the file costs at most one repeated reminder.
