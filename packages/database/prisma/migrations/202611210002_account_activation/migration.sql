ALTER TABLE "AccountEmailToken" DROP CONSTRAINT "AccountEmailToken_purpose_check";
ALTER TABLE "AccountEmailToken" ADD CONSTRAINT "AccountEmailToken_purpose_check"
CHECK ("purpose" IN ('VERIFY_EMAIL', 'RESET_PASSWORD', 'ACTIVATE_ACCOUNT'));
