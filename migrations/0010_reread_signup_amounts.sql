-- Step 13 fix: sign-up amounts were read as the whole checkout's subtotal. Read them again, from the contract's own lines.
-- Zero (a contract with no checkout order) was never read from a subtotal and stays.
UPDATE "Subscription" SET "signupCents" = NULL WHERE "signupCents" > 0;
