using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class Endpoint {
    public string region { get; set; }
    public string baseUrl { get; set; }
    public string apiKey { get; set; }
    public bool signedIn { get; set; }
    public int accountCount { get; set; }
    public int modelCount { get; set; }
    public Model[] models { get; set; }
}
internal sealed class Model { public string id { get; set; } public string name { get; set; } }
internal sealed class Ready { public string kind { get; set; } public Endpoint[] endpoints { get; set; } }

internal sealed class Bridge : Form {
    private readonly Label status = new Label { AutoSize = true, Text = "Stopped" };
    private readonly FlowLayoutPanel rows = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer startup = new System.Windows.Forms.Timer { Interval = 60000 };
    private Process child;
    private bool quitting;

    public Bridge() {
        Text = "WorkBuddy Model Bridge";
        Size = new Size(820, 620);
        MinimumSize = new Size(650, 450);
        var controls = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 45 };
        controls.Controls.Add(ActionButton("Start", StartGateway));
        controls.Controls.Add(ActionButton("Stop", StopGateway));
        controls.Controls.Add(status);
        Controls.Add(rows);
        Controls.Add(controls);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, delegate { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Start", null, delegate { StartGateway(); });
        menu.Items.Add("Stop", null, delegate { StopGateway(); });
        menu.Items.Add("Quit", null, delegate { quitting = true; Close(); });
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = Text, Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += delegate { Show(); Activate(); };
        startup.Tick += delegate { StopGateway(); status.Text = "Startup timed out; check WorkBuddy login and retry."; };
        Shown += delegate { StartGateway(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); return; }
            StopGateway(); tray.Dispose(); startup.Dispose();
        };
    }

    private static Button ActionButton(string text, Action action) {
        var button = new Button { Text = text, AutoSize = true };
        button.Click += delegate { action(); };
        return button;
    }

    // Never log ready records: they contain the local API key.
    internal static Ready ParseReady(string line) {
        var ready = new JavaScriptSerializer().Deserialize<Ready>(line);
        if (ready == null || ready.kind != "ready" || ready.endpoints == null || ready.endpoints.Length != 2)
            throw new InvalidDataException("Invalid gateway readiness record");
        foreach (var endpoint in ready.endpoints) {
            Uri url;
            if (!Uri.TryCreate(endpoint.baseUrl, UriKind.Absolute, out url) || url.Scheme != "http" || url.Host != "127.0.0.1" ||
                endpoint.apiKey == null || endpoint.apiKey.Length < 32 || endpoint.models == null)
                throw new InvalidDataException("Invalid local endpoint");
        }
        return ready;
    }

    private void Dispatch(Action action) {
        if (!IsDisposed && IsHandleCreated) { try { BeginInvoke(action); } catch (InvalidOperationException) { } }
    }

    private void StartGateway() {
        if (child != null) return;
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkBuddy Model Bridge");
            Directory.CreateDirectory(home);
            string keyPath = Path.Combine(home, "gateway-key.dpapi");
            byte[] key;
            if (File.Exists(keyPath)) key = ProtectedData.Unprotect(File.ReadAllBytes(keyPath), null, DataProtectionScope.CurrentUser);
            else {
                key = new byte[32];
                using (var random = RandomNumberGenerator.Create()) random.GetBytes(key);
                using (var file = new FileStream(keyPath, FileMode.CreateNew, FileAccess.Write)) {
                    byte[] encrypted = ProtectedData.Protect(key, null, DataProtectionScope.CurrentUser);
                    file.Write(encrypted, 0, encrypted.Length);
                }
            }
            if (key.Length != 32) throw new InvalidDataException("Invalid stored key");
            var info = new ProcessStartInfo(Path.Combine(root, "node.exe"), "\"" + Path.Combine(root, "Gateway", "macGateway.js") + "\"") {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
                RedirectStandardError = true, RedirectStandardInput = true, WorkingDirectory = root,
                StandardOutputEncoding = Encoding.UTF8
            };
            info.EnvironmentVariables["WORKBUDDY_GATEWAY_API_KEY"] = Convert.ToBase64String(key);
            info.EnvironmentVariables["WORKBUDDY_GATEWAY_HOME"] = home;
            info.EnvironmentVariables["WORKBUDDY_GATEWAY_MANAGED"] = "1";
            Array.Clear(key, 0, key.Length);
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null) return;
                try {
                    Ready ready = ParseReady(e.Data);
                    Dispatch(delegate { if (child == process) { startup.Stop(); Render(ready); } });
                } catch { Dispatch(delegate { if (child == process) { StopGateway(); status.Text = "Invalid gateway response."; } }); }
            };
            // Drain stderr without exposing account tokens or local secrets in UI/logs.
            process.ErrorDataReceived += delegate { };
            process.Exited += delegate { Dispatch(delegate {
                if (child == process) { child = null; startup.Stop(); rows.Controls.Clear(); status.Text = "Gateway exited. Check WorkBuddy login and retry."; process.Dispose(); }
            }); };
            child = process;
            status.Text = "Starting...";
            if (!process.Start()) throw new InvalidOperationException();
            process.BeginOutputReadLine(); process.BeginErrorReadLine(); startup.Start();
        } catch {
            StopGateway();
            status.Text = "Cannot start. Check bundled files and Windows user profile.";
        }
    }

    private void Render(Ready ready) {
        rows.Controls.Clear(); status.Text = "Running (close window to keep running in tray)";
        foreach (var endpoint in ready.endpoints) {
            var panel = new FlowLayoutPanel { Width = 750, Height = 210, FlowDirection = FlowDirection.TopDown, WrapContents = false };
            panel.Controls.Add(new Label { AutoSize = true, Text = (endpoint.region == "cn" ? "China" : "Global") + " | " + (endpoint.signedIn ? "Signed in" : "Sign in to WorkBuddy, then restart gateway") });
            panel.Controls.Add(new TextBox { Width = 700, ReadOnly = true, Text = endpoint.baseUrl });
            panel.Controls.Add(ActionButton("Copy Base URL", delegate { Copy(endpoint.baseUrl); }));
            panel.Controls.Add(ActionButton("Copy API Key", delegate { Copy(endpoint.apiKey); }));
            var models = new ComboBox { Width = 700, DropDownStyle = ComboBoxStyle.DropDownList };
            foreach (var model in endpoint.models) models.Items.Add(model.id + " — " + model.name);
            if (models.Items.Count > 0) models.SelectedIndex = 0;
            panel.Controls.Add(new Label { AutoSize = true, Text = endpoint.accountCount + " accounts | " + endpoint.modelCount + " models" });
            panel.Controls.Add(models); rows.Controls.Add(panel);
        }
    }

    private void Copy(string value) {
        try { Clipboard.SetText(value); } catch { status.Text = "Clipboard busy. Please retry."; }
    }

    private void StopGateway() {
        startup.Stop();
        var process = child; child = null;
        if (process != null) {
            try { if (!process.HasExited) { process.StandardInput.WriteLine("stop"); process.StandardInput.Close(); } } catch (InvalidOperationException) { } catch (IOException) { }
            try {
                if (!process.WaitForExit(5000)) {
                    child = process;
                    rows.Controls.Clear(); status.Text = "Waiting for gateway shutdown; retry Stop.";
                    return;
                }
            } catch (InvalidOperationException) { }
            // Closing stdin also shuts down the managed gateway. Do not terminate other processes.
            process.Dispose();
        }
        rows.Controls.Clear(); status.Text = "Stopped";
    }

    [STAThread]
    private static void Main() {
        bool created;
        using (var mutex = new Mutex(true, "Local\\WorkBuddyModelBridge", out created)) {
            if (!created) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Bridge());
        }
    }
}
