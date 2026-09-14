// Root build file. This project is deliberately outside the pnpm workspace: it
// is built by Gradle, from this directory, and shares no tooling with the
// TypeScript packages.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
