# LinkedIn Job Application Bot

Automates LinkedIn Easy Apply forms with Playwright. Candidate facts come from `config.js`.
Known fields are answered locally; AI is used only for questions that cannot be answered reliably
from configuration.

## Answer Flow

1. Use deterministic answers from `config.js` for salary, experience, notice period, availability,
   contact details, location, authorization, relocation, and sponsorship.
2. Try Anthropic Claude when `ANTHROPIC_API_KEY` is configured.
3. Try OpenAI when `OPENAI_API_KEY` is configured and Claude fails or returns an invalid answer.
4. Use a conservative local fallback.
5. Leave unresolved numeric or multiple-choice fields blank instead of guessing.

Numeric answers are validated before typing. HTML number fields without a `step` attribute are
treated as integer-only, because browsers default them to `step=1`.

## Setup

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
Copy-Item config.example.js config.js
```

Edit `config.js` with your candidate details. Put API keys in `.env`, never in `config.js`.
Fill `skillExperienceYears` when LinkedIn asks for exact experience in Java, Node.js, React, or
another technology. Unknown skill-specific experience is left unresolved instead of using total
experience.

```dotenv
ANTHROPIC_API_KEY=your_anthropic_api_key
OPENAI_API_KEY=your_openai_api_key
```

Only one key is required. With both keys, Claude is tried first and OpenAI is the fallback.

## Get An Anthropic Key

1. Open https://platform.claude.com/settings/keys.
2. Sign in or create a Claude Platform account.
3. Add billing or credits if the account requires it.
4. Create an API key.
5. Put it in `.env` as `ANTHROPIC_API_KEY`.

The old key that was previously stored in `config.js` should be revoked and replaced.

## Get An OpenAI Key

1. Open https://platform.openai.com/.
2. Sign in or create an API Platform account.
3. Configure billing at https://platform.openai.com/settings/organization/billing.
4. Open https://platform.openai.com/api-keys.
5. Select **Create new secret key**.
6. Put it in `.env` as `OPENAI_API_KEY`.

ChatGPT subscriptions and API billing are separate. Keep the secret key private.

## Save LinkedIn Login

```powershell
node save-session.js
```

Log in in the browser, return to the terminal, and press Enter.

## Run

```powershell
npm test
node index.js
```

The bot opens a real browser. Do not interact with it while an application is being processed.
Application history is stored in `applications.json`.
