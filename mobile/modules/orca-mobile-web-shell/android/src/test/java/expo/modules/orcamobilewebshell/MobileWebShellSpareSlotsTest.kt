package expo.modules.orcamobilewebshell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileWebShellSpareSlotsTest {
  private class FakePage : MobileWebShellSparePage {
    override var isUsable = true
    var destroyed = false

    override fun destroy() {
      destroyed = true
      isUsable = false
    }
  }

  private val slots = MobileWebShellSpareSlots<FakePage>()

  private fun park(sessionId: String, hostKey: String = "host-a", directory: String = "/gen/1"): FakePage {
    val page = FakePage()
    slots.park(hostKey, directory, sessionId) { page }
    return page
  }

  @Test
  fun `a spare is taken once, and only for the host and directory it was booted from`() {
    park("s1")
    assertNull(slots.take("host-b", "/gen/1"))
    assertNull(slots.take("host-a", "/gen/2"))
    assertEquals("s1", slots.take("host-a", "/gen/1")?.sessionId)
    assertNull(slots.take("host-a", "/gen/1"))
  }

  @Test
  fun `a dead spare is never handed out, and a new one is wanted in its place`() {
    val page = park("s1")
    page.isUsable = false
    assertTrue(slots.wants("host-a", "/gen/1"))
    assertNull(slots.take("host-a", "/gen/1"))
  }

  @Test
  fun `a live spare for the same host and directory is not booted twice`() {
    park("s1")
    assertFalse(slots.wants("host-a", "/gen/1"))
    assertTrue(slots.wants("host-a", "/gen/2"))
    assertTrue(slots.wants("host-b", "/gen/1"))
  }

  @Test
  fun `parking replaces the spare app-wide and destroys the one it replaced`() {
    val first = park("s1", hostKey = "host-a")
    park("s2", hostKey = "host-b")
    assertTrue(first.destroyed)
    assertNull(slots.take("host-a", "/gen/1"))
  }

  @Test
  fun `an id is never booted twice, even after its page is gone`() {
    park("s1")
    slots.discardAll()
    var booted = false
    assertFalse(slots.park("host-a", "/gen/1", "s1") { booted = true; FakePage() })
    assertFalse(booted)
    assertTrue(slots.wasIssued("s1"))
    assertFalse(slots.wasIssued("s2"))
  }

  @Test
  fun `a claimed spare is adopted once, and expiring it after adoption does nothing`() {
    val page = park("s1")
    slots.take("host-a", "/gen/1")
    assertEquals(page, slots.adopt("s1")?.page)
    assertNull(slots.adopt("s1"))
    slots.expire("s1")
    assertFalse(page.destroyed)
  }

  @Test
  fun `a claimed spare nobody adopted is destroyed when it expires`() {
    val page = park("s1")
    slots.take("host-a", "/gen/1")
    slots.expire("s1")
    assertTrue(page.destroyed)
    assertNull(slots.adopt("s1"))
  }

  @Test
  fun `discarding a host leaves another host's spare and every claimed one`() {
    val parked = park("s1", hostKey = "host-a")
    slots.discard("host-b")
    assertFalse(parked.destroyed)
    slots.take("host-a", "/gen/1")
    slots.discard("host-a")
    slots.discard(null)
    assertFalse(parked.destroyed)
  }

  @Test
  fun `discarding everything takes the claimed spares too`() {
    val claimed = park("s1", hostKey = "host-a")
    slots.take("host-a", "/gen/1")
    val parked = park("s2", hostKey = "host-b")
    slots.discardAll()
    assertTrue(claimed.destroyed)
    assertTrue(parked.destroyed)
    assertNull(slots.adopt("s1"))
  }
}
