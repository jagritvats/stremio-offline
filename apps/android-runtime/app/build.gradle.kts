plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.stremiooffline"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.stremiooffline"
        // NotificationChannel and the java.time-free APIs used here are all API 26.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")
}

// No dependencies, on purpose. Spike 1 needs an HTTP server on loopback, an
// intent filter and a notification, and the framework has all three. Nothing
// here should grow a dependency before the spike answers its question.
dependencies {}
