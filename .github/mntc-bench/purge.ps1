# Empties the Windows standby list (file cache) so "cold" Windows-side reads hit the disk. Throwaway runner only.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class StandbyPurge {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct TP { public int Count; public long Luid; public int Attr; }
  [DllImport("ntdll.dll")] static extern int NtSetSystemInformation(int c, ref int info, int len);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h, int acc, out IntPtr tok);
  [DllImport("advapi32.dll")] static extern bool LookupPrivilegeValue(string s, string n, out long luid);
  [DllImport("advapi32.dll")] static extern bool AdjustTokenPrivileges(IntPtr tok, bool dis, ref TP n, int len, IntPtr p, IntPtr r);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static int Run() {
    IntPtr t; OpenProcessToken(GetCurrentProcess(), 0x28, out t);
    TP tp = new TP(); tp.Count = 1; tp.Attr = 2;
    LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", out tp.Luid);
    AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    int cmd = 4; return NtSetSystemInformation(80, ref cmd, 4);
  }
}
'@
[StandbyPurge]::Run()
