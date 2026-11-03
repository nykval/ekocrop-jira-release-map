import {getStore} from "@netlify/blobs";
import worker from "../../src/worker.mjs";
import {createJobsStore} from "../../src/netlify-jobs.mjs";

export default async function api(request, context) {
  const store = getStore({name: "ekocrop-jobs", region: "eu-central-1", consistency: "strong"});
  const env = {
    JOBS: createJobsStore(store),
    PLATFORM: "netlify-functions",
    CLIENT_IP: context.ip,
    APP_EMAIL: process.env.APP_EMAIL || "a.skorokirzha@iotos.ru",
    APP_PASSWORD: process.env.APP_PASSWORD,
    JIRA_BASE_URL: process.env.JIRA_BASE_URL || "https://dev.ekoniva-apk.com",
    JIRA_SUMMARY_WEBHOOK_URL: process.env.JIRA_SUMMARY_WEBHOOK_URL,
    JIRA_SUMMARY_WEBHOOK_TOKEN: process.env.JIRA_SUMMARY_WEBHOOK_TOKEN,
    JIRA_SUMMARY_CALLBACK_URL: process.env.JIRA_SUMMARY_CALLBACK_URL,
    JIRA_POLL_TOKEN: process.env.JIRA_POLL_TOKEN,
  };
  return worker.fetch(request, env);
}

export const config = {path: "/api/*"};
