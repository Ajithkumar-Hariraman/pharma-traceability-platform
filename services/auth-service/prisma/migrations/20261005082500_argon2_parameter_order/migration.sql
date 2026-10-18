-- Argon2 PHC encoders may order time and parallelism parameters differently.
ALTER TABLE "User" DROP CONSTRAINT "User_password_hash_check";
ALTER TABLE "User" ADD CONSTRAINT "User_password_hash_check" CHECK (
  "passwordHash" ~ '^[$]2[aby][$][0-9]{2}[$][./A-Za-z0-9]{53}$'
  OR "passwordHash" ~ '^[$]argon2(id|i|d)[$]v=[0-9]+[$]m=[0-9]+,(t=[0-9]+,p=[0-9]+|p=[0-9]+,t=[0-9]+)[$][A-Za-z0-9+/]+[$][A-Za-z0-9+/]+$'
);
