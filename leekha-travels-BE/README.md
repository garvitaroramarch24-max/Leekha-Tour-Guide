# Leekha Travels Backend

Node.js and Express API using Supabase Auth, Postgres, and Storage.

## Setup

1. Use Node.js 20 or newer and run `npm install` in this folder.
2. In Supabase, open the SQL Editor and run `supabase/schema.sql`.
3. Create an admin user in Supabase Authentication. Copy its user UUID, then add that user to the allowlist:

   ```sql
   INSERT INTO public.admin_users (user_id, email)
   VALUES ('AUTH_USER_UUID', 'admin@example.com');
   ```

4. Copy `.env.example` to `.env` and fill in the Supabase project URL, anon key, and service role key from Project Settings > API. Keep the service role key only in this backend environment.
5. Configure inquiry email delivery in the backend `.env`: set `GMAIL_USER` to the Gmail account that will send email, `GMAIL_APP_PASSWORD` to an App Password generated for that account (Google 2-Step Verification must be enabled; remove spaces from the generated password), and `INQUIRY_TO_EMAIL` to the recipient. The current recipient is `leekhaashish@gmail.com`. Never use your regular Gmail password or expose the App Password in frontend variables.
6. Run `npm run dev` here. The API listens on `http://localhost:3001`.

The SQL creates the packages table and configures the public-read `travel-photos` bucket; it does not add sample packages. Add, edit, and delete packages through the admin dashboard. Admin-only API operations are guarded by Supabase Auth and the `admin_users` allowlist. Uploaded images are validated and stored in Supabase Storage.

Trip requests are sent by the backend through Gmail SMTP. Set the same three email variables in your production backend environment; until they are configured, the form will report that email delivery is unavailable instead of showing a false success.

For the frontend, run `npm run dev` in `../leekha-travels`. Vite proxies `/api` requests to this service. For deployment, set the frontend API URL to the deployed backend and set `FRONTEND_ORIGIN` to the deployed frontend origin.