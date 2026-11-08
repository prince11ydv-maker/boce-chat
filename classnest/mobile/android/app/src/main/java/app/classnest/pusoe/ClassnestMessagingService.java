package app.classnest.pusoe;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** FCM notifications use generic text; class details require the authenticated app. */
public final class ClassnestMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        NativePush.refreshed(this, token);
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        CountDownLatch displayed = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                if (!NativePush.enabled(this) || !NativePush.permissionGranted(this) || NativePush.sessionCookie().isEmpty()) return;
                NativePush.createChannel(this);
                String destination = UrlPolicy.notificationDestination(message.getData().get("url"));
                Intent open = new Intent(this, MainActivity.class).setAction("CLASSNEST_NOTIFICATION")
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                if (destination != null) open.putExtra("url", destination);
                String reference = message.getData().get("notificationId");
                if (reference == null || !reference.matches("[A-Za-z0-9_-]{1,128}")) reference = message.getMessageId();
                if (reference == null) reference = "classnest-update";
                int id = reference.hashCode() & 0x7fffffff;
                PendingIntent action = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification notification = new Notification.Builder(this, NativePush.CHANNEL)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(getString(R.string.app_name))
                    .setContentText(getString(R.string.phone_alert_generic))
                    .setStyle(new Notification.BigTextStyle().bigText(getString(R.string.phone_alert_generic)))
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    .setCategory(Notification.CATEGORY_SOCIAL)
                    .setAutoCancel(true)
                    .setContentIntent(action)
                    .build();
                try { getSystemService(NotificationManager.class).notify(reference, id, notification); }
                catch (SecurityException ignored) { /* Permission can be revoked while delivery is in flight. */ }
            } finally { displayed.countDown(); }
        });
        // Finish the short visible-notification work before FCM releases its service.
        try { displayed.await(5, TimeUnit.SECONDS); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    }
}
