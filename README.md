# warera-mu-bot (Kemet-core)

> This is the Kemet-core WarEra Discord bot (not the RAAD dashboard). It lives on the `kemet-bot-v2` branch of this repo.

Discord bot for a WarEra military unit. Python 3.10+, discord.py.

## Setup
1. `pip install -r requirements.txt` (add `pytest` to run the tests).
2. Copy `.env.example` to `.env` and fill it in. Keys (names only):
   `DISCORD_TOKEN`, `WARERA_API_KEY`, `MU_ID`, `OWNER_ROLE_ID`, `OWNER_USER_ID`,
   `ALERT_CHANNEL_ID`, `WEEKLY_CHANNEL_ID`, `COUNTRY_ID`, `WEEKLY_DAY`, `WEEKLY_HOUR`, `BATTLE_POLL_SECONDS`.
   `.env` is in `.gitignore`. Never commit it.
3. In the Discord developer portal turn on the **Server Members Intent** for the bot.
4. The bot role needs Manage Roles and Manage Nicknames, and must sit above the Eco/War/MU roles.
5. Run: `python bot.py`

## Commands
- `/link`, `/unlink`, `/player`, `/pill_remind`, `/help`: everyone. Linking or unlinking someone else is owner only.
- `/mu_roster`, `/mu_weekly`, `/mu_sync`, `/pill_remind_all`: owner only.
- Owner = Administrator permission, a role in `OWNER_ROLE_ID`, or a user in `OWNER_USER_ID`.

## Automatic
- Battle alert in `ALERT_CHANNEL_ID` when a battle starts for `COUNTRY_ID` (or the MU's country), and when the MU gets orders in a battle.
- Weekly damage summary in `WEEKLY_CHANNEL_ID` (falls back to `ALERT_CHANNEL_ID`) on `WEEKLY_DAY` after `WEEKLY_HOUR` UTC.
- Pill reminders that end within 2 minutes of each other in one channel go out as one message.

## Data files (created in `data/` and the project folder)
`data/linked_players.json`, `reminders.json`, `data/alerts_state.json`, `data/weekly_warrior_history.json`.
Writes are locked and atomic.

## Tests
`python -m pytest tests` (no token needed, API and Discord are mocked).
