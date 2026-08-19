# Academic Command Center: The Ultimate GPA Tracker

Welcome to the Academic Command Center, a high-performance GPA and academic progress tracking application designed for students with complex university schedules. This project provides a robust, Firebase-backed solution for managing courses, predicting future academic outcomes, and visualizing performance data.

## Features

### Dynamic Academic Organization
* **Smart Semester/Period Logic:** Automatically handles standard semesters split into Period A and B (Semesters 1, 2, 4, 5) and Compact Semesters (Semesters 3, 6) where periods are combined.
* **Hierarchical Grouping:** View your transcript organized by your specific academic schedule.
* **Course Detail Drawer:** Manage professor info, office hours, and study notes for every course.

### Predictive Analytics & Visualization
* **Target GPA Simulator:** Calculate exactly what performance you need in future semesters to reach your graduation goal.
* **Progress Graphs:** Visualize your GPA progression across semesters using dynamic charts.
* **Grade Distribution:** See an immediate breakdown of your entire academic history (A’s, B’s, etc.) in a visual format.

### Performance & Data
* **Real-time Synchronization:** Data is safely stored and synced across devices using Firebase Firestore.
* **Data Portability:** Easily export your transcript to CSV for backups or import bulk data for new semesters.
* **Interactive Sorting & Filtering:** Multi-tier filtering and sorting across all academic data columns.

## Tech Stack
* **Frontend:** HTML5, Tailwind CSS, Vanilla JavaScript (ES6+).
* **Charts:** Chart.js for GPA progression and grade distribution.
* **Backend:** Firebase Authentication (Email/Password) & Firebase Firestore (Real-time NoSQL).

## Getting Started

### Prerequisites
* A Firebase account and project.
* A basic web server (such as Live Server in VS Code) to bypass CORS restrictions.

### Setup Instructions
1. **Firebase Configuration:**
   * Create a Firestore database and enable Authentication in your Firebase Console.
   * Update your `firebase-config.js` with your specific API keys and project settings.
2. **Security Rules:**
   * Apply the following Firestore rules to protect user data:
     ```javascript
     rules_version = '2';
     service cloud.firestore {
       match /databases/{database}/documents {
         match /users/{userId}/courses/{courseId} {
           allow read, write: if request.auth != null && request.auth.uid == userId;
         }
       }
     }
     ```
3. **Running the App:**
   * Open the project folder in VS Code.
   * Start using the Live Server extension to launch the app at `http://127.0.0.1:5500`.
