using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class SmokeTests {
    [STAThread]
    private static int Main(string[] args) {
        try {
            var assembly = Assembly.LoadFrom(args[0]);
            var type = assembly.GetType("Bridge", true);
            var parse = type.GetMethod("ParseReady", BindingFlags.Static | BindingFlags.NonPublic);
            string endpoint = "{\"region\":\"cn\",\"baseUrl\":\"http://127.0.0.1:15971/v1\",\"apiKey\":\"" + new string('x', 32) + "\",\"models\":[]}";
            string valid = "{\"kind\":\"ready\",\"endpoints\":[" + endpoint + "," + endpoint.Replace("cn", "global").Replace("15971", "15972") + "]}";
            var ready = parse.Invoke(null, new object[] { valid });
            foreach (string invalid in new[] { "{}", "invalid", valid.Replace("127.0.0.1", "example.com"), valid.Replace(new string('x', 32), "short") }) {
                bool rejected = false;
                try { parse.Invoke(null, new object[] { invalid }); } catch (TargetInvocationException) { rejected = true; }
                if (!rejected) throw new Exception("Unsafe readiness record accepted");
            }
            using (var form = (Form)Activator.CreateInstance(type)) {
                var handle = form.Handle;
                type.GetMethod("Render", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new[] { ready });
                if (form.Controls[0].Controls.Count != 2) throw new Exception("Missing endpoint panels");
                var info = new ProcessStartInfo(args[1], "-e \"process.stdin.resume();process.stdin.on('data',()=>process.exit(0));process.stdin.on('end',()=>process.exit(0))\"") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true
                };
                using (var child = Process.Start(info)) {
                    int pid = child.Id;
                    type.GetField("child", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, child);
                    type.GetMethod("StopGateway", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, null);
                    try { using (var remaining = Process.GetProcessById(pid)) { if (!remaining.HasExited) throw new Exception("Orphan gateway"); } } catch (ArgumentException) { }
                }
                // User closing the main window must retain the tray application.
                var closing = new FormClosingEventArgs(CloseReason.UserClosing, false);
                typeof(Form).GetMethod("OnFormClosing", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] { closing });
                if (!closing.Cancel) throw new Exception("Closing window exits application");
                type.GetField("quitting", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, true);
                typeof(Form).GetMethod("OnFormClosing", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] { new FormClosingEventArgs(CloseReason.ApplicationExitCall, false) });
            }
            Console.WriteLine("PASS: readiness validation, endpoint panels, managed shutdown, close-to-tray. No real credentials read.");
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
